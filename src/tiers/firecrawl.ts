import {
  FIRECRAWL_API_KEY,
  FIRECRAWL_API_VERSION,
  FIRECRAWL_WAIT_FOR_MS,
} from "../config.js";
import {
  type FetchTuning,
  readBoundedText,
  type TierResult,
} from "../fetch-utils.js";
import {
  firecrawlEndpoint,
  firecrawlSupportsActions,
} from "../firecrawl-api.js";
import type { FirecrawlScrapeResponse } from "../types.js";

/**
 * A page-level status that counts as a clean load. Anything else is the page
 * failing, not the tier — 2xx plus 304, which a conditional request can return
 * with a body served from cache.
 */
function isCleanPageStatus(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304;
}

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
  // matching subtree) is unchanged across both API versions.
  if (tuning?.targetSelector) body.includeTags = [tuning.targetSelector];
  if (tuning?.waitForSelector) {
    if (firecrawlSupportsActions()) {
      // v1: a wait action, which waits on the selector itself.
      body.actions = [{ type: "wait", selector: tuning.waitForSelector }];
    } else {
      // v2: no self-hostable engine implements `actions` — sending one returns
      // HTTP 400 SCRAPE_ACTIONS_NOT_SUPPORTED and fails the whole request, so
      // leaving it in would turn every wait_for_selector call into a hard tier
      // miss. `waitFor` is the closest thing the playwright engine offers and
      // it is a SEMANTIC DOWNGRADE: a fixed delay, not a selector match. The
      // page may still be unsettled when the wait elapses, and the wait is
      // paid in full even when the selector was already present. Documented in
      // the README; tunable via FIRECRAWL_WAIT_FOR_MS.
      body.waitFor = FIRECRAWL_WAIT_FOR_MS;
    }
  }

  const res = await fetch(firecrawlEndpoint("scrape"), {
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

  // Bounded read (2 MB cap) before JSON.parse — consistency with the rest of
  // the fetch layer; caps memory even on an unexpected oversized response.
  const data = JSON.parse(
    await readBoundedText(res),
  ) as FirecrawlScrapeResponse;

  if (!data.success || !data.data) {
    throw new Error(data.error ?? "Firecrawl returned no data");
  }

  // v2 separates two status layers: the API's own HTTP status plus `success`
  // (checked above), and the *page's* status under data.metadata.statusCode. A
  // 404 page comes back as a 200/success:true envelope wrapping an error page,
  // which previously landed in domain_stats as a tier-1 success and cached the
  // error page as content.
  //
  // v2 only. Under v1 this would be a live-path behaviour change, and nothing
  // in the live path may move before P4 of the migration.
  if (FIRECRAWL_API_VERSION === "v2") {
    const pageStatus = data.data.metadata?.statusCode;
    if (typeof pageStatus === "number" && !isCleanPageStatus(pageStatus)) {
      throw new Error(`Firecrawl page status: ${pageStatus}`);
    }
  }

  const title = data.data.metadata?.title ?? url;
  const text = (data.data.markdown ?? "").slice(0, maxChars);
  const html = data.data.html;

  return { title, url: data.data.metadata?.sourceURL ?? url, text, html };
}
