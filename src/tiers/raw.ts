import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import {
  assertPublicUrl,
  readBoundedText,
  type TierResult,
  USER_AGENT,
} from "../fetch-utils.js";

export async function rawFetch(
  url: string,
  maxChars = 8000,
): Promise<TierResult> {
  // Defensive SSRF guard — all current callers go through fetchPage which
  // also calls this, but rawFetch is exported so the guard protects against
  // future direct callers (SSRF-08).
  assertPublicUrl(url);

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });

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
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  const text = (article?.textContent ?? html).slice(0, maxChars);
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
  // Defensive SSRF guard — function is exported, so protect against future
  // direct callers with an internal URL (SSRF-08 parity with rawFetch).
  try {
    assertPublicUrl(url);
    const res = await fetch(url, {
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
