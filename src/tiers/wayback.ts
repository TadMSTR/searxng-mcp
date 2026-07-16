import { readBoundedText, safeFetch, type TierResult } from "../fetch-utils.js";
import { rawFetch } from "./raw.js";

const CDX_URL = "https://archive.org/wayback/available";
const WAYBACK_TIMEOUT = 8000;
// Generous cap for a fixed-schema CDX JSON response (~300 bytes typical).
const CDX_MAX_BYTES = 64 * 1024;

export async function waybackFetch(
  url: string,
  maxChars = 8000,
): Promise<TierResult | null> {
  try {
    const cdx = await safeFetch(`${CDX_URL}?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(WAYBACK_TIMEOUT),
    });
    if (!cdx.ok) return null;
    const raw = await readBoundedText(cdx);
    const data = JSON.parse(raw.slice(0, CDX_MAX_BYTES)) as Record<
      string,
      unknown
    >;
    const closest = (
      data.archived_snapshots as Record<
        string,
        { url?: string; timestamp?: string }
      >
    )?.closest;
    if (!closest?.url) return null;
    // Enforce that the CDX response points to archive.org — defensive check in case
    // of API compromise or unexpected response shape.
    if (!closest.url.startsWith("https://web.archive.org/")) return null;

    const archiveDate = closest.timestamp
      ? `${closest.timestamp.slice(0, 4)}-${closest.timestamp.slice(4, 6)}-${closest.timestamp.slice(6, 8)}`
      : "unknown date";
    const provenance = `> [via Wayback Machine, archived ${archiveDate}]\n\n`;

    // Snapshot URLs are always archive.org — public, passes assertPublicUrl.
    // rawFetch calls assertPublicUrl internally.
    const result = await rawFetch(closest.url, maxChars);
    return {
      ...result,
      title: `[Archived] ${result.title}`,
      text: provenance + result.text,
    };
  } catch {
    return null;
  }
}
