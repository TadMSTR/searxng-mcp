import type { JSDOM } from "jsdom";

const ARTICLE_TYPES = new Set([
  "Article",
  "NewsArticle",
  "BlogPosting",
  "TechArticle",
  // Common schema.org Article subtypes seen in the wild. Omitting them made a
  // page indistinguishable from one carrying no JSON-LD at all.
  "ScholarlyArticle",
  "ReportageNewsArticle",
  "AnalysisNewsArticle",
  "OpinionNewsArticle",
  "ReviewNewsArticle",
  "BackgroundNewsArticle",
  "AdvertiserContentArticle",
  "LiveBlogPosting",
  "SocialMediaPosting",
  "DiscussionForumPosting",
]);

const MAX_JSONLD_BYTES = 1_000_000;
// Bound on nesting followed through arrays and @graph. Real documents nest one
// or two levels; this only stops a pathological or hostile payload.
const MAX_GRAPH_DEPTH = 6;

export interface JsonLdArticle {
  title?: string;
  text?: string;
}

export interface JsonLdScan {
  // An Article-shaped node exists on the page. Deliberately independent of
  // whether that node carried usable content: this answers "does this domain
  // publish JSON-LD Article schema", which is what the domain DB samples and
  // what shouldSkipJsonLdPostExtract gates on.
  present: boolean;
  // The first node carrying a usable headline or articleBody, for the
  // extraction path. Frequently null on a page where `present` is true —
  // headline-and-metadata-only JSON-LD is the common case, not the exception.
  article: JsonLdArticle | null;
}

function normalizeType(t: unknown): string[] {
  const raw =
    typeof t === "string"
      ? [t]
      : Array.isArray(t)
        ? t.filter((x): x is string => typeof x === "string")
        : [];
  // `"@type": "https://schema.org/NewsArticle"` is valid and appears in the
  // wild; a bare-name comparison silently misses it.
  return raw.map((name) => name.replace(/^https?:\/\/schema\.org\//i, ""));
}

function isArticleNode(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const types = normalizeType((value as Record<string, unknown>)["@type"]);
  return types.some((t) => ARTICLE_TYPES.has(t));
}

function pickArticle(value: unknown): JsonLdArticle | null {
  if (!isArticleNode(value)) return null;
  const headline =
    typeof value.headline === "string" ? value.headline : undefined;
  const articleBody =
    typeof value.articleBody === "string" ? value.articleBody : undefined;
  if (!headline && !articleBody) return null;
  return { title: headline, text: articleBody };
}

// Walks arrays and @graph containers, accumulating presence separately from
// extractability. Both are collected in one pass because the scan is otherwise
// identical and this runs on every post-extract.
function walk(value: unknown, scan: JsonLdScan, depth: number): void {
  if (depth > MAX_GRAPH_DEPTH || !value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) walk(item, scan, depth + 1);
    return;
  }

  if (isArticleNode(value)) {
    scan.present = true;
    scan.article ??= pickArticle(value);
  }

  const graph = (value as Record<string, unknown>)["@graph"];
  if (graph !== undefined) walk(graph, scan, depth + 1);
}

/**
 * Scan a document's JSON-LD blocks for Article schema, reporting presence and
 * extractable content as separate facts.
 *
 * They must stay separate. `applyPostExtract` previously reported presence as
 * `result.source === "json_ld"` — true only when JSON-LD supplied the page
 * body, which additionally requires an `articleBody` of at least
 * MIN_JSONLD_BODY_CHARS. Sites overwhelmingly publish headline and metadata
 * without a body, so the domain DB recorded json_ld_article present on 0 of 111
 * sampled pages while og:title, checked directly against the HTML, read 40% on
 * the same sample. shouldSkipJsonLdPostExtract then latched those domains off
 * after five samples, making the false negative self-sustaining.
 */
export function scanJsonLd(dom: JSDOM): JsonLdScan {
  const scan: JsonLdScan = { present: false, article: null };
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
    walk(parsed, scan, 0);
    // Keep scanning even once an article is found: a later block may still be
    // the one that flips `present`, and stopping early would reintroduce a
    // content-dependent presence signal.
  }
  return scan;
}

export function extractJsonLdArticle(dom: JSDOM): JsonLdArticle | null {
  return scanJsonLd(dom).article;
}
