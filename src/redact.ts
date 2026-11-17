/**
 * Strip userinfo from every URL-shaped substring of arbitrary text.
 *
 * `redactUrlCredentials` (log.ts) takes a string that IS a URL. This takes a
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
  //
  // A ':' inside the userinfo is NOT required. It used to be, on the reasoning
  // that a bare `scheme://host@` was not a credential — but `scheme://TOKEN@host`
  // is precisely how a bearer token or a GitHub PAT appears in a URL, and that
  // form passed through unredacted (audit searxng-mcp-release-hygiene-2026-09,
  // Low). That no configured credential takes that shape today is a fact about
  // a deployment, not a property of this function, and this function now backs five
  // describeTransportFailure call sites, so a shape it misses leaks on all of
  // them at once.
  //
  // Excluding '/' is what keeps it honest: an '@' in a path, query or fragment
  // (`github.com/@handle`, `?q=a@b.com`, `matrix.to/#/@user:server`) cannot be
  // reached without crossing a '/', so those are left alone. Covered by controls
  // in tests/log.test.ts — without them a regex that redacted every '@' would
  // satisfy every positive case here.
  //
  // The scheme run is capped at 63 characters. Unbounded, it scanned from every
  // word-boundary start to the end of the text looking for `://`, which is
  // quadratic on dotted text (160 KB of "a." took 6 s), and boundRelayedText
  // runs this over upstream error text before it truncates. The run after
  // `://` needs no cap: it stops at the first '/', '@' or whitespace, and
  // every `://` contains a '/', so those runs never overlap. Real schemes are
  // far shorter (`postgresql+asyncpg` is 18). Timing test in tests/log.test.ts.
  return text.replace(
    /\b([a-z][a-z0-9+.-]{0,62}:\/\/)[^\s/@]+@/gi,
    "$1<redacted>@",
  );
}
