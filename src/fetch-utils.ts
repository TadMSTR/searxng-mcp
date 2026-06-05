// Shared primitives used by both src/fetch.ts (orchestrator) and src/tiers/*.ts
// (tier handlers). Kept here to avoid circular imports — fetch.ts imports
// from ./tiers/index.js, so tier files cannot import back from ./fetch.js.

export const USER_AGENT =
  "searxng-mcp/3.7.0 (+https://github.com/TadMSTR/searxng-mcp; personal research)";

// Hard cap on HTML bytes read into memory per fetch. Anything larger than
// this is dropped — the metadata extractors aren't useful on multi-megabyte
// rendered pages anyway, and uncapped reads make the JSDOM constructor a
// memory-amplification target (IV-14).
export const RAW_HTML_MAX_BYTES = 2 * 1024 * 1024;

export interface TierResult {
  title: string;
  url: string;
  text: string;
  html?: string;
}

export function assertPublicUrl(url: string): void {
  const { protocol } = new URL(url);
  // Strip IPv6 brackets so patterns like /^::1$/ match [::1] addresses correctly
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  // http:// is intentionally permitted: Wayback Machine snapshots, some legacy sites,
  // and local service integrations (Kiwix, Firecrawl) may use non-TLS URLs.
  // Private/RFC-1918 addresses are blocked below regardless of scheme.
  if (!/^https?:$/.test(protocol)) {
    throw new Error(`Only http/https URLs are supported`);
  }
  const blocked = [
    /^localhost$/i,
    /^127\./,
    /^0\.0\.0\.0$/,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^host\.docker\.internal$/i,
    /^fc[0-9a-f]{2}:/i,
    /^fe[89ab][0-9a-f]:/i,
    /^::1$/,
    /^0:0:0:0:0:0:0:1$/,
    /^fd[0-9a-f]{2}:/i,
    /^169\.254\./, // RFC 3927 link-local / AWS IMDS (F-04)
    /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // RFC 6598 CGNAT (F-04)
  ];
  if (blocked.some((r) => r.test(hostname))) {
    throw new Error(`Internal/private addresses are not allowed`);
  }
}

export function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

export async function readBoundedText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, RAW_HTML_MAX_BYTES);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < RAW_HTML_MAX_BYTES) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  // Drop any in-flight remainder if we hit the cap.
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
    .toString("utf-8")
    .slice(0, RAW_HTML_MAX_BYTES);
}
