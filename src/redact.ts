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
  // A run is the text after a `scheme://` up to the next whitespace. It is
  // judged from its FIRST scheme (credentialCut below): a `x://` inside a
  // password is part of that password, not the start of another URL. Only when
  // the run has nothing to redact does a later scheme in it start a run of its
  // own, so `https://a.example/r?to=https://u:pw@b.example` is still scrubbed.
  //
  // The scheme run is capped at 63 characters. Unbounded, it scanned from every
  // word-boundary start to the end of the text looking for `://`, which is
  // quadratic on long dotted text, and boundRelayedText runs this over upstream
  // error text before it truncates. Real schemes are far shorter
  // (`postgresql+asyncpg` is 18). Timing tests in tests/log.test.ts.
  //
  // Linear overall. Each scheme match is found once. The whitespace end and the
  // last '@' of a segment are found once and shared by every run that starts
  // inside it. A cut is at the segment's last '@', so nothing after it can hold
  // credentials and the scan resumes at the segment's end. An authority ends at
  // the first '/' after its start, so the authorities of nested runs overlap
  // by at most one scheme name.
  const scheme = /\b[a-z][a-z0-9+.-]{0,62}:\/\//gi;
  let out = "";
  let copied = 0;
  let segEnd = -1;
  let segLastAt = -1;
  for (let m = scheme.exec(text); m !== null; m = scheme.exec(text)) {
    const start = m.index + m[0].length;
    if (start < copied) continue;
    if (start >= segEnd) {
      segEnd = start;
      segLastAt = -1;
      while (segEnd < text.length && !/\s/.test(text[segEnd])) {
        if (text[segEnd] === "@") segLastAt = segEnd;
        segEnd++;
      }
    }
    if (segLastAt < start) {
      // No '@' from here to the whitespace: nothing in it can be userinfo.
      scheme.lastIndex = segEnd;
      continue;
    }
    const cut = credentialCut(text, start, segEnd, segLastAt);
    if (cut < 0) continue; // a later scheme in this run may still hold one
    out += `${text.slice(copied, start)}<redacted>`;
    copied = cut;
    scheme.lastIndex = segEnd;
  }
  return out + text.slice(copied);
}

// Where the userinfo of the run text[start, end) ends: the index of the '@'
// that is kept, or -1 when the run carries none. `lastAt` is the run's last
// '@' (>= start).
//
// The authority is everything before the first '/'. A '?' or '#' does not end
// it here: an unencoded '#' or '?' in a password is common, and running the
// authority to the '/' keeps those passwords inside it.
function credentialCut(
  text: string,
  start: number,
  end: number,
  lastAt: number,
): number {
  const slash = text.indexOf("/", start);
  const authEnd = slash < 0 || slash >= end ? end : slash;
  const authority = text.slice(start, authEnd);

  // An '@' in the authority means userinfo. It ends at the LAST '@' in the
  // authority, as WHATWG URL parsing does, unless the run has a later '@':
  // then the password may itself hold '@' and then '/' (`u:a@b/c@host`),
  // and Node echoes all of it, so the cut moves to the run's last '@'. That
  // over-redacts a credentialed URL that also has an '@' in its path, the
  // cheaper mistake. A ':' is not required: `scheme://TOKEN@host` is how a
  // bearer token or a GitHub PAT appears in a URL (audit
  // searxng-mcp-release-hygiene-2026-09, Low).
  if (authority.includes("@")) return lastAt;

  // No '@' before the first '/'. Usually that is an ordinary path, query or
  // fragment '@' (`github.com/@handle`, `/?q=a@b.com`, `matrix.to/#/@user`),
  // left alone. But a password with a raw '/' (`u:pa/ss@host`), or with a
  // `x://` in it, splits there too, and Node echoes it in "Failed to parse URL
  // from …". The tell is an authority that is not host[:port]: a ':' followed
  // by anything but digits. Then the authority is ambiguous, and everything up
  // to the run's last '@' is redacted: over-redacting a path is the cheaper
  // mistake. Controls for both sides in tests/log.test.ts.
  if (!/^(\[[^\]]*\]|[^:]*)(:\d*)?$/.test(authority)) return lastAt;
  return -1;
}
