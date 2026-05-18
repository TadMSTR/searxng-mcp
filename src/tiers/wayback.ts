import type { TierResult } from "../fetch-utils.js";
import { rawFetch } from "./raw.js";

const CDX_URL = "https://archive.org/wayback/available";
const WAYBACK_TIMEOUT = 8000;

export async function waybackFetch(
  url: string,
  maxChars = 8000,
): Promise<TierResult | null> {
  try {
    const cdx = await fetch(`${CDX_URL}?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(WAYBACK_TIMEOUT),
    });
    if (!cdx.ok) return null;
    const data = (await cdx.json()) as Record<string, unknown>;
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
