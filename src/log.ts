// Minimal stderr logging with the shared `[searxng-mcp]` prefix. stderr is the
// one sink that is always on and never depends on configuration, so the
// failure/degradation paths log here directly rather than relying on counters
// that may not be exported anywhere.
//
// This comment previously said stderr was the ONLY telemetry sink wired on the
// running PM2 process. Both halves were wrong: the deployment is Docker, not
// PM2, and OTel and NATS are in fact wired there — the startup capability line
// reports `otel,nats` in its on-list. stderr is the floor, not the whole story.
//
// `logThrottled` dedupes noisy repeats (e.g. a cache that is down for minutes)
// to one line per interval per key.

const PREFIX = "[searxng-mcp]";

export function logInfo(message: string): void {
  console.error(`${PREFIX} ${message}`);
}

export function logError(message: string): void {
  console.error(`${PREFIX} ${message}`);
}

export function logWarn(message: string): void {
  console.error(`${PREFIX} ${message}`);
}

const lastLoggedAt = new Map<string, number>();

/**
 * Log at most once per `intervalMs` for a given `key`. Used on the cache
 * error/unavailable paths and the graceful-degradation fallbacks so a sustained
 * outage leaves a periodic breadcrumb instead of flooding the log on every call.
 */
export function logThrottled(
  key: string,
  message: string,
  intervalMs = 60_000,
): void {
  const now = Date.now();
  const prev = lastLoggedAt.get(key);
  if (prev !== undefined && now - prev < intervalMs) return;
  lastLoggedAt.set(key, now);
  console.error(`${PREFIX} ${message}`);
}

/** Test-only: reset the throttle state between cases. */
export function resetLogThrottle(): void {
  lastLoggedAt.clear();
}

/**
 * Redact the password from a connection URL before logging it. Forge's cache
 * URL carries an inline password (`redis://:<pw>@host`), so logging it verbatim
 * would leak the secret into the PM2 log. Keeps host/port/db for diagnostics.
 */
export function redactUrlCredentials(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<url>";
  }
}

/**
 * Strip userinfo from every URL-shaped substring of arbitrary text.
 *
 * `redactUrlCredentials` above takes a string that IS a URL. This takes a
 * string that merely CONTAINS one — which is the shape a credential actually
 * escapes in. Node's `fetch` rejects a credentialed URL with
 *
 *     TypeError: Request cannot be constructed from a URL that includes
 *     credentials: http://user:pw@host/search?q=x
 *
 * so the secret arrives embedded in an error message, not as a bare URL. Any
 * sink that forwards `err.message` — a log line, a NATS event, an OTel span, an
 * error returned to the caller — leaks it unless the whole message is scrubbed.
 *
 * Applied at the generic sinks rather than at each call site: this class of leak
 * has already been introduced twice in this subsystem by guarding one path and
 * missing the others, and error text can originate from any library.
 */
export function redactUrlCredentialsInText(text: string): string {
  // scheme:// then a userinfo segment (no '/', '@' or whitespace) ending at '@'.
  // Requires a ':' so a bare `http://host@` style is left alone.
  return text.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*@/gi,
    "$1<redacted>@",
  );
}
