import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

export interface ReadabilityResult {
  title?: string;
  text: string;
}

export function runReadability(
  html: string,
  url: string,
): ReadabilityResult | null {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article?.textContent) return null;
    return {
      title: article.title ?? undefined,
      text: article.textContent,
    };
  } catch {
    return null;
  }
}

const MIN_TEXT_CHARS = 500;

export function preferReadability(
  readability: ReadabilityResult | null,
  current: { text: string },
): boolean {
  if (!readability) return false;
  if (current.text.length < MIN_TEXT_CHARS) return true;
  return readability.text.length > current.text.length;
}
