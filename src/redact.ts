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
  // Each `scheme://` starts a token that runs to the next whitespace or the
  // next `scheme://`, whichever comes first. Each token is scrubbed on its own
  // (scrubToken below), so two URLs in one message are judged separately.
  //
  // The scheme run is capped at 63 characters. Unbounded, it scanned from every
  // word-boundary start to the end of the text looking for `://`, which is
  // quadratic on long dotted text, and boundRelayedText runs this over upstream
  // error text before it truncates. Real schemes are far shorter
  // (`postgresql+asyncpg` is 18). Timing test in tests/log.test.ts.
  //
  // Linear overall: each scheme match is found once (the look-ahead match is
  // reused as the next token's start), and each token's characters are walked
  // once, since tokens never overlap.
  const scheme = /\b[a-z][a-z0-9+.-]{0,62}:\/\//gi;
  let out = "";
  let copied = 0;
  let m = scheme.exec(text);
  while (m !== null) {
    const start = m.index + m[0].length;
    const next = scheme.exec(text);
    const limit = next === null ? text.length : next.index;
    let end = start;
    while (end < limit && !/\s/.test(text[end])) end++;
    out += text.slice(copied, start) + scrubToken(text.slice(start, end));
    copied = end;
    m = next;
  }
  return out + text.slice(copied);
}

// The authority is everything before the first '/'. A '?' or '#' does not end
// it here: an unencoded '#' or '?' in a password is common, and running the
// authority to the '/' keeps those passwords inside it.
function scrubToken(token: string): string {
  const lastAt = token.lastIndexOf("@");
  if (lastAt < 0) return token;
  const slash = token.indexOf("/");
  const authority = slash < 0 ? token : token.slice(0, slash);

  // userinfo ends at the LAST '@' in the authority, as WHATWG URL parsing
  // does. Stopping at the first one left the rest of a password holding a raw
  // '@' (`u:p@ss@host`) in the text. A ':' is not required:
  // `scheme://TOKEN@host` is how a bearer token or a GitHub PAT appears in a
  // URL (audit searxng-mcp-release-hygiene-2026-09, Low).
  const authAt = authority.lastIndexOf("@");
  if (authAt >= 0) return `<redacted>${token.slice(authAt)}`;

  // No '@' before the first '/'. Usually that is an ordinary path, query or
  // fragment '@' (`github.com/@handle`, `/?q=a@b.com`, `matrix.to/#/@user`),
  // left alone. But a password with a raw '/' (`u:pa/ss@host`) splits at that
  // '/' too, and Node echoes it in "Failed to parse URL from …". The tell is
  // an authority that is not host[:port]: a ':' followed by anything but
  // digits. Then the authority is ambiguous, and everything up to the last
  // '@' in the token is redacted: over-redacting a path is the cheaper
  // mistake. Controls for both sides in tests/log.test.ts.
  if (!/^(\[[^\]]*\]|[^:]*)(:\d*)?$/.test(authority)) {
    return `<redacted>${token.slice(lastAt)}`;
  }
  return token;
}
