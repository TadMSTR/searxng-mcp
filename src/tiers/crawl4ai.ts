import {
  ADBLOCK_PROXY_URL,
  CRAWL4AI_API_TOKEN,
  CRAWL4AI_URL,
} from "../config.js";
import {
  preferReadability,
  runReadability,
} from "../extractors/readability.js";
import type { TierResult } from "../fetch-utils.js";

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
      const resp = await fetch(`${CRAWL4AI_URL}/task/${taskId}`, { signal });
      if (!resp.ok) return null;

      const data = (await resp.json()) as Record<string, unknown>;
      if (data.status === "completed") {
        const result = data.result as Record<string, unknown> | null;
        const md = result?.markdown as Record<string, string> | null;
        const mdRaw = preferFit
          ? md?.fit_markdown || md?.raw_markdown
          : md?.raw_markdown || md?.fit_markdown;
        const text = (mdRaw ?? "").slice(0, maxChars);
        const metadata = result?.metadata as Record<string, string> | null;
        const title = metadata?.title || url;
        const html =
          typeof result?.html === "string"
            ? (result.html as string)
            : undefined;
        return text ? { title, url, text, html } : null;
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
    const resp = await fetch(`${CRAWL4AI_URL}/crawl`, {
      method: "POST",
      headers: crawlHeaders,
      body: JSON.stringify({
        urls: [url],
        ...(ADBLOCK_PROXY_URL
          ? { proxy_config: { server: ADBLOCK_PROXY_URL } }
          : {}),
      }),
      signal: controller.signal,
    });

    if (!resp.ok) return null;
    const data = (await resp.json()) as Record<string, unknown>;

    // Synchronous response — results returned directly
    if (Array.isArray(data.results) && data.results.length > 0) {
      const result = data.results[0] as Record<string, unknown>;
      const md = result.markdown as Record<string, string> | null;
      const mdRaw = preferFit
        ? md?.fit_markdown || md?.raw_markdown
        : md?.raw_markdown || md?.fit_markdown;
      const text = (mdRaw ?? "").slice(0, maxChars);
      if (!text) return null;
      const metadata = result.metadata as Record<string, string> | null;
      const title = metadata?.title || url;
      const html =
        typeof result.html === "string" ? (result.html as string) : undefined;
      return { title, url, text, html };
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
