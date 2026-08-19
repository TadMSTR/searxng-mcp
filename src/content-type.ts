// Content-type classification and rendering for non-HTML responses.
//
// Tier1 (Firecrawl) is asked for `formats: ["markdown","html"]`. Handed a JSON
// body it has nothing to render, returns empty markdown, and runTier records
// that as `empty_result` — which read as "Firecrawl is broken" when Firecrawl
// was healthy and simply being asked the wrong question. The lifetime tier1
// failure set was dominated by JSON and CDN endpoints: api.osv.dev,
// registry.npmjs.org, cdn.jsdelivr.net, data.jsdelivr.com, api.codetabs.com,
// api.allorigins.win, registry.terraform.io.
//
// This is a routing gap, not a fetcher fault. Structured payloads want a raw
// HTTP GET and a fenced block, not a headless browser.

import { safeFetch, USER_AGENT } from "./fetch-utils.js";

export type StructuredKind = "json" | "xml" | "yaml" | "toml" | "csv" | "text";

// A HEAD costs one round trip against a cascade whose first stop is a browser
// render, so the probe is cheap in context — but it still must never become the
// reason a fetch hangs.
const PROBE_TIMEOUT_MS = 3000;

// Checked before the table below. `application/xhtml+xml` is markup for a
// browser, not data, but it satisfies the generic `+xml` pattern — without this
// it would be diverted to raw fetch and served as a fenced blob.
const HTML_MIMES = new Set([
  "text/html",
  "application/xhtml+xml",
  "application/xhtml",
]);

const SUBTYPE_KINDS: Array<[RegExp, StructuredKind]> = [
  // `+json` covers application/ld+json, application/vnd.api+json, and the long
  // tail of vendor JSON types that a bare application/json check misses.
  [/^application\/(.*\+)?json$/, "json"],
  [/^application\/(.*\+)?xml$/, "xml"],
  [/^text\/xml$/, "xml"],
  [/^application\/(x-)?yaml$/, "yaml"],
  [/^text\/(x-)?yaml$/, "yaml"],
  [/^application\/toml$/, "toml"],
  [/^text\/toml$/, "toml"],
  [/^text\/csv$/, "csv"],
  [/^text\/plain$/, "text"],
];

/**
 * Classify a Content-Type header. Returns null for HTML, for anything binary,
 * and for a missing or unparseable header — callers treat null as "not
 * structured, use the normal cascade", so an unknown type never diverts a page
 * away from the browser tiers.
 */
export function classifyContentType(
  header: string | null | undefined,
): StructuredKind | null {
  if (!header) return null;
  const mime = header.split(";")[0]?.trim().toLowerCase();
  if (!mime) return null;
  if (HTML_MIMES.has(mime)) return null;
  for (const [pattern, kind] of SUBTYPE_KINDS) {
    if (pattern.test(mime)) return kind;
  }
  return null;
}

/**
 * Whether a body is markup despite what its header claims.
 *
 * `text/plain` is worth fast-pathing — READMEs, robots.txt, raw source files —
 * but servers do mislabel HTML as text/plain, and treating that as plain text
 * would hand the caller a page full of raw tags instead of extracted prose.
 * Only the opening bytes are examined; a document that mentions `<html>` in its
 * body is not one.
 */
export function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 1024).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

const FENCE_LANG: Record<StructuredKind, string> = {
  json: "json",
  xml: "xml",
  yaml: "yaml",
  toml: "toml",
  csv: "csv",
  text: "",
};

/**
 * Render a structured body for an LLM consumer. JSON is re-indented so a
 * minified API response is legible; everything else is passed through. Plain
 * text is returned bare — it is already readable and a fence would only add
 * noise.
 */
export function renderStructured(body: string, kind: StructuredKind): string {
  if (kind === "text") return body;

  let rendered = body;
  if (kind === "json") {
    try {
      rendered = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // Truncated or non-conforming JSON — fence it as-is rather than
      // discarding a body the caller may still be able to use.
      rendered = body;
    }
  }
  return `\`\`\`${FENCE_LANG[kind]}\n${rendered}\n\`\`\``;
}

/**
 * HEAD-probe a URL to decide whether it serves structured data.
 *
 * Fails open: any error, timeout, non-OK status, or server that refuses HEAD
 * returns null and the caller runs its normal cascade. A probe that cannot
 * answer must never cost the caller a fetch.
 *
 * Callers must have already run assertResolvedPublic — safeFetch re-applies the
 * string-level guard and the DNS-validating dispatcher, but the ordering keeps
 * this consistent with the other pre-cascade dispatches.
 */
export async function probeStructuredContent(
  url: string,
): Promise<StructuredKind | null> {
  try {
    const res = await safeFetch(url, {
      method: "HEAD",
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // A redirect tells us nothing about the final body's type, and following it
    // here would sidestep the redirect handling the tiers already do.
    if (!res.ok) return null;
    return classifyContentType(res.headers.get("content-type"));
  } catch {
    return null;
  }
}
