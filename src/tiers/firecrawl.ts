import { FIRECRAWL_API_KEY, FIRECRAWL_URL } from "../config.js";
import type { FetchTuning, TierResult } from "../fetch-utils.js";
import type { FirecrawlScrapeResponse } from "../types.js";

export async function firecrawlScrape(
  url: string,
  maxChars = 8000,
  tuning?: FetchTuning,
): Promise<TierResult> {
  const body: Record<string, unknown> = {
    url,
    formats: ["markdown", "html"],
  };
  // Only add selector fields when requested, so default scrapes are byte-for-
  // byte identical to before. target_selector → includeTags (keep only the
  // matching subtree); wait_for_selector → a wait action before extraction.
  if (tuning?.targetSelector) body.includeTags = [tuning.targetSelector];
  if (tuning?.waitForSelector) {
    body.actions = [{ type: "wait", selector: tuning.waitForSelector }];
  }

  const res = await fetch(`${FIRECRAWL_URL}/v1/scrape`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Firecrawl error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as FirecrawlScrapeResponse;

  if (!data.success || !data.data) {
    throw new Error(data.error ?? "Firecrawl returned no data");
  }

  const title = data.data.metadata?.title ?? url;
  const text = (data.data.markdown ?? "").slice(0, maxChars);
  const html = data.data.html;

  return { title, url: data.data.metadata?.sourceURL ?? url, text, html };
}
