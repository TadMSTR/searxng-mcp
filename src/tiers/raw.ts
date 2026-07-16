import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { ProxyAgent } from "undici";
import { ADBLOCK_PROXY_URL } from "../config.js";
import {
  type FetchTuning,
  readBoundedText,
  safeFetch,
  type TierResult,
  USER_AGENT,
} from "../fetch-utils.js";

// Create a ProxyAgent once at module init when ADBLOCK_PROXY_URL is configured.
// Passed as `dispatcher` to undici-backed fetch calls (Node.js 18+ global fetch).
const proxyAgent = ADBLOCK_PROXY_URL ? new ProxyAgent(ADBLOCK_PROXY_URL) : null;

export async function rawFetch(
  url: string,
  maxChars = 8000,
  tuning?: FetchTuning,
): Promise<TierResult> {
  // SSRF guard: safeFetch applies the string-level check (protecting future
  // direct callers, SSRF-08) and, absent the adblock proxy, routes through the
  // DNS-validating dispatcher so a public host resolving to a private address
  // is rejected at connect time. redirect: "manual" means we never follow a
  // redirect to an internal target — 3xx is thrown below.
  const fetchOptions: Parameters<typeof fetch>[1] & {
    dispatcher?: ProxyAgent;
  } = {
    headers: { "User-Agent": USER_AGENT },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  };
  if (proxyAgent) fetchOptions.dispatcher = proxyAgent;

  const res = await safeFetch(url, fetchOptions);

  if (res.headers.get("content-type")?.includes("application/pdf")) {
    throw new Error(
      "PDF content cannot be extracted by raw fetch — use Crawl4AI",
    );
  }
  if (res.status >= 300 && res.status < 400) {
    // Don't echo the Location header into the thrown message — a redirect
    // to an internal address would surface that address to the MCP caller
    // (OE-02).
    throw new Error(`Redirect not followed (${res.status})`);
  }
  if (!res.ok)
    throw new Error(`Raw fetch error: ${res.status} ${res.statusText}`);

  const html = await readBoundedText(res);
  const dom = new JSDOM(html, { url }); // runScripts not set — script execution disabled

  // Client-side target_selector: scope extraction to the matched subtree.
  // wait_for_selector is a no-op here (raw HTTP renders no JS). If the selector
  // matches nothing, fall through to full-page extraction rather than erroring.
  let doc = dom.window.document;
  let selectorFallback: string | null = null;
  if (tuning?.targetSelector) {
    const el = doc.querySelector(tuning.targetSelector);
    if (el) {
      selectorFallback = el.textContent;
      doc = new JSDOM(el.outerHTML, { url }).window.document;
    }
  }

  const reader = new Readability(doc);
  const article = reader.parse();

  const text = (article?.textContent ?? selectorFallback ?? html).slice(
    0,
    maxChars,
  );
  const title = article?.title ?? url;
  return { title, url, text, html };
}

export async function fetchRawHtmlForMetadata(
  url: string,
): Promise<string | null> {
  // Raw HTTP fetch (no JS rendering) used as the source for JSON-LD and meta
  // tags. Tier 1/2 puppeteer renders inject payment-widget og:title tags and
  // can strip JSON-LD scripts; the unrendered HTML is more reliable for
  // post-extraction. Bounded by RAW_HTML_MAX_BYTES so large pages can't
  // amplify into a JSDOM-memory hazard (IV-14).
  // SSRF guard via safeFetch (string check + DNS-validating dispatcher);
  // exported, so protect against future direct callers with an internal URL
  // (SSRF-08 parity with rawFetch).
  try {
    const res = await safeFetch(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await readBoundedText(res);
  } catch {
    return null;
  }
}
