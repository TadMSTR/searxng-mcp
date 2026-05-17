import { JSDOM } from "jsdom";
import { extractJsonLdArticle } from "./jsonld.js";
import { extractTitle } from "./title.js";

export interface PostExtractInput {
  url: string;
  html: string;
  baselineTitle: string;
  baselineText: string;
  maxChars: number;
}

export interface PostExtractResult {
  title: string;
  text: string;
  source: "json_ld" | "baseline";
}

const MIN_JSONLD_BODY_CHARS = 300;

function isBaselineTitleUseful(
  title: string | undefined,
  url: string,
): boolean {
  if (!title) return false;
  if (title === url) return false;
  if (title.length < 8) return false;
  return true;
}

export function postExtract(input: PostExtractInput): PostExtractResult {
  const { url, html, baselineTitle, baselineText, maxChars } = input;

  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url });
  } catch {
    return {
      title: baselineTitle || url,
      text: baselineText.slice(0, maxChars),
      source: "baseline",
    };
  }

  // JSON-LD Article schema wins unconditionally when its articleBody is substantive.
  // (Per build plan 1A: "applies to raw HTML regardless of which tier served it".)
  const jsonLd = extractJsonLdArticle(dom);
  const jsonLdBodyUsable =
    !!jsonLd?.text && jsonLd.text.length >= MIN_JSONLD_BODY_CHARS;

  if (jsonLdBodyUsable && jsonLd?.text) {
    return {
      title: jsonLd.title || extractTitle(dom, baselineTitle || url),
      text: jsonLd.text.slice(0, maxChars),
      source: "json_ld",
    };
  }

  // No JSON-LD body — keep the tier's body and run the <head>-scoped title
  // cascade (per build plan 1B). The cascade is scoped to <head>, so payment-
  // widget / footer meta tags can't pollute it. Fall back to the tier's
  // baseline title only when the cascade returns the URL fallback.
  const cascadedTitle = extractTitle(dom, "");
  const title = cascadedTitle
    ? cascadedTitle
    : isBaselineTitleUseful(baselineTitle, url)
      ? baselineTitle
      : url;

  return {
    title,
    text: baselineText.slice(0, maxChars),
    source: "baseline",
  };
}
