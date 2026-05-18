import { readBoundedText, type TierResult } from "../fetch-utils.js";
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
    const cdx = await fetch(`${CDX_URL}?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(WAYBACK_TIMEOUT),
    });
    if (!cdx.ok) return null;
    const raw = await readBoundedText(cdx);
    const data = JSON.parse(raw.slice(0, CDX_MAX_BYTES)) as Record<
      string,
      unknown
    >;
    const snapshotUrl = (
      data.archived_snapshots as Record<string, { url?: string }>
    )?.closest?.url;
    if (!snapshotUrl) return null;

    // Snapshot URLs are always archive.org — public, passes assertPublicUrl.
    // rawFetch calls assertPublicUrl internally.
    const result = await rawFetch(snapshotUrl, maxChars);
    return { ...result, title: `[Archived] ${result.title}` };
  } catch {
    return null;
  }
}
