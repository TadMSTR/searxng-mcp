import type { JSDOM } from "jsdom";

const ARTICLE_TYPES = new Set([
  "Article",
  "NewsArticle",
  "BlogPosting",
  "TechArticle",
]);

const MAX_JSONLD_BYTES = 1_000_000;

export interface JsonLdArticle {
  title?: string;
  text?: string;
}

function normalizeType(t: unknown): string[] {
  if (typeof t === "string") return [t];
  if (Array.isArray(t))
    return t.filter((x): x is string => typeof x === "string");
  return [];
}

function pickArticle(value: unknown): JsonLdArticle | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const types = normalizeType(obj["@type"]);
  if (!types.some((t) => ARTICLE_TYPES.has(t))) return null;

  const headline = typeof obj.headline === "string" ? obj.headline : undefined;
  const articleBody =
    typeof obj.articleBody === "string" ? obj.articleBody : undefined;
  if (!headline && !articleBody) return null;

  return { title: headline, text: articleBody };
}

function walkGraph(value: unknown): JsonLdArticle | null {
  const direct = pickArticle(value);
  if (direct) return direct;
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const graph = obj["@graph"];
  if (Array.isArray(graph)) {
    for (const item of graph) {
      const found = pickArticle(item);
      if (found) return found;
    }
  }
  return null;
}

export function extractJsonLdArticle(dom: JSDOM): JsonLdArticle | null {
  const scripts = dom.window.document.querySelectorAll(
    'script[type="application/ld+json"]',
  );
  for (const script of Array.from(scripts)) {
    const raw = script.textContent ?? "";
    if (raw.length === 0 || raw.length > MAX_JSONLD_BYTES) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const candidate of candidates) {
      const found = walkGraph(candidate);
      if (found) return found;
    }
  }
  return null;
}
