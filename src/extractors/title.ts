import type { JSDOM } from "jsdom";

const SUFFIX_STRIP = /\s*[|–—-]\s*[^|–—-]+$/;
const MIN_TITLE_CHARS = 8;

function longestMeta(
  scope: Element | Document,
  selectors: string[],
): string | undefined {
  let best: string | undefined;
  for (const sel of selectors) {
    for (const el of Array.from(scope.querySelectorAll(sel))) {
      const content = el.getAttribute("content")?.trim();
      if (!content || content.length < MIN_TITLE_CHARS) continue;
      if (!best || content.length > best.length) best = content;
    }
  }
  return best;
}

function strippedTitle(doc: Document): string | undefined {
  const t = doc.querySelector("title")?.textContent?.trim();
  if (!t) return undefined;
  const stripped = t.replace(SUFFIX_STRIP, "").trim();
  return stripped.length >= 4 ? stripped : t;
}

export function extractTitle(dom: JSDOM, fallbackUrl: string): string {
  const doc = dom.window.document;
  // Scope meta lookups to <head> so payment-widget / footer-injected meta tags
  // (common on Shopify product pages) don't pollute the cascade. Take the
  // longest matching value because puppeteer-rendered HTML can have multiple
  // og:title tags injected by third-party scripts, and the first is rarely
  // the canonical one.
  const head = doc.head ?? doc;

  const og = longestMeta(head, [
    'meta[property="og:title"]',
    'meta[name="og:title"]',
  ]);
  const tw = longestMeta(head, [
    'meta[name="twitter:title"]',
    'meta[property="twitter:title"]',
  ]);
  const ttl = strippedTitle(doc);

  const candidates = [og, tw, ttl].filter(
    (c): c is string => !!c && c.length >= MIN_TITLE_CHARS,
  );
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
  }

  const h1 = doc.querySelector("h1")?.textContent?.trim();
  if (h1 && h1.length >= MIN_TITLE_CHARS) return h1;

  return fallbackUrl;
}
