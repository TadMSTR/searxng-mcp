import {
  ADBLOCK_PROXY_URL,
  CRAWL4AI_API_TOKEN,
  CRAWL4AI_URL,
} from "../config.js";
import {
  preferReadability,
  runReadability,
} from "../extractors/readability.js";
import {
  type FetchTuning,
  readBoundedText,
  type TierResult,
} from "../fetch-utils.js";

/**
 * The crawl4ai version this tier is written against.
 *
 * Not decoration: the async job API was renamed *and* reshaped between the
 * version this code was first written for and this one, and both changes failed
 * silently — a wrong route returns 404 and a wrong shape yields empty markdown,
 * and each was indistinguishable from "the page had no content". The route and
 * shape assertions in tests/tiers/crawl4ai-job-api.test.ts run against a
 * fixture captured from this version's live /openapi.json.
 */
export const CRAWL4AI_TARGET_VERSION = "0.8.6";

/**
 * Pull a TierResult out of one crawl4ai result object — the element of the
 * `results` array, which is the same shape whether it arrived synchronously
 * from /crawl or inside a completed job's envelope.
 */
function resultToTier(
  result: Record<string, unknown> | null | undefined,
  url: string,
  maxChars: number,
  preferFit: boolean,
): TierResult | null {
  const md = result?.markdown as Record<string, string> | null;
  const mdRaw = preferFit
    ? md?.fit_markdown || md?.raw_markdown
    : md?.raw_markdown || md?.fit_markdown;
  const text = (mdRaw ?? "").slice(0, maxChars);
  if (!text) return null;
  const metadata = result?.metadata as Record<string, string> | null;
  const title = metadata?.title || url;
  const html =
    typeof result?.html === "string" ? (result.html as string) : undefined;
  return { title, url, text, html };
}

/**
 * Poll an enqueued crawl job to completion.
 *
 * Two independent defects lived here, both silent (vikunja#684):
 *
 * The route was `/task/{id}`, which does not exist on 0.8.6 — it 404s, the
 * `!resp.ok` guard returned null, and the tier recorded an ordinary miss. That
 * spelling is still printed in upstream's own installation doc, which is
 * probably why two forge repos wrote it independently; the deployed
 * /openapi.json is the only authority.
 *
 * The response shape was also wrong, and repointing the route alone would not
 * have surfaced it. A completed job answers
 * `{status, task_id, url, created_at, _links, result: {results: [...], success}}`
 * — the crawl result is one level deeper than the old code's `data.result`.
 * Reading the old path yields undefined markdown, empty text, and another
 * silent miss. Older backends returned the flat shape, so both are accepted.
 */
export async function pollCrawl4aiTask(
  taskId: string,
  url: string,
  maxChars: number,
  signal: AbortSignal,
  preferFit = false,
): Promise<TierResult | null> {
  const deadline = Date.now() + 40_000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (signal.aborted) return null;

    try {
      const resp = await fetch(`${CRAWL4AI_URL}/crawl/job/${taskId}`, {
        signal,
      });
      if (!resp.ok) {
        // A 404 here is the signature of exactly the bug this replaces: the
        // route moved and every crawl became an unexplained miss. Say so, so
        // the next rename is a visible failure rather than a silent tier drop.
        if (resp.status === 404) {
          console.error(
            `[searxng-mcp] crawl4ai job poll got 404 for /crawl/job/${taskId} — ` +
              `route or task expiry changed? this tier targets crawl4ai ${CRAWL4AI_TARGET_VERSION}`,
          );
        }
        return null;
      }

      const data = JSON.parse(await readBoundedText(resp)) as Record<
        string,
        unknown
      >;
      if (data.status === "completed") {
        const envelope = data.result as Record<string, unknown> | null;
        // 0.8.6: result.results[0]. Older backends put the crawl result
        // directly in `result`.
        const nested = Array.isArray(envelope?.results)
          ? (envelope.results[0] as Record<string, unknown> | undefined)
          : undefined;
        return resultToTier(nested ?? envelope, url, maxChars, preferFit);
      }
      if (data.status === "failed") return null;
    } catch {
      return null;
    }
  }

  return null;
}

export async function crawl4aiFetch(
  url: string,
  maxChars = 8000,
  preferFit = false,
  tuning?: FetchTuning,
): Promise<TierResult | null> {
  if (!CRAWL4AI_URL) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const crawlHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (CRAWL4AI_API_TOKEN)
      crawlHeaders.Authorization = `Bearer ${CRAWL4AI_API_TOKEN}`;
    // crawler_config is only attached when a selector is requested, so default
    // crawls send the exact same body as before. Crawl4AI honors css_selector
    // (scope extraction) and wait_for (CSS selector) natively.
    const crawlerConfig: Record<string, string> = {};
    if (tuning?.targetSelector)
      crawlerConfig.css_selector = tuning.targetSelector;
    if (tuning?.waitForSelector) {
      crawlerConfig.wait_for = `css:${tuning.waitForSelector}`;
    }
    const resp = await fetch(`${CRAWL4AI_URL}/crawl`, {
      method: "POST",
      headers: crawlHeaders,
      body: JSON.stringify({
        urls: [url],
        ...(ADBLOCK_PROXY_URL
          ? { proxy_config: { server: ADBLOCK_PROXY_URL } }
          : {}),
        ...(Object.keys(crawlerConfig).length > 0
          ? { crawler_config: crawlerConfig }
          : {}),
      }),
      signal: controller.signal,
    });

    if (!resp.ok) return null;
    // Bounded read (2 MB cap) before JSON.parse — consistency with the rest of
    // the fetch layer; caps memory even on an unexpected oversized response.
    const data = JSON.parse(await readBoundedText(resp)) as Record<
      string,
      unknown
    >;

    // Synchronous response — results returned directly. This is the path that
    // actually runs on 0.8.6: POST /crawl is synchronous there and never
    // returns a task_id. The async branch below is a compatibility path for
    // backends that answer 202 with one.
    if (Array.isArray(data.results) && data.results.length > 0) {
      return resultToTier(
        data.results[0] as Record<string, unknown>,
        url,
        maxChars,
        preferFit,
      );
    }

    // Asynchronous response — poll for completion
    if (typeof data.task_id === "string") {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(data.task_id)) return null;
      return await pollCrawl4aiTask(
        data.task_id,
        url,
        maxChars,
        controller.signal,
        preferFit,
      );
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function applyTier2Readability(
  fetched: TierResult,
  url: string,
): TierResult {
  if (!fetched.html) return fetched;
  const readable = runReadability(fetched.html, url);
  if (preferReadability(readable, fetched) && readable) {
    return {
      ...fetched,
      title: readable.title ?? fetched.title,
      text: readable.text,
    };
  }
  return fetched;
}
