// Minimal stderr logging with the shared `[searxng-mcp]` prefix. stderr is the
// only telemetry sink wired on the running PM2 process (OTel/NATS are opt-in and
// usually unset), so the failure/degradation paths log here directly rather than
// relying on those counters. `logThrottled` dedupes noisy repeats (e.g. a cache
// that is down for minutes) to one line per interval per key.

const PREFIX = "[searxng-mcp]";

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
