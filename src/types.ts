import { z } from "zod";

export interface DomainProfile {
  boost?: string[];
  block?: string[];
}

export type TierSlot = "tier1" | "tier2" | "tier3";

export interface DomainConfig {
  boost: string[];
  block: string[];
  llms_txt?: string[];
  tier_skip?: Record<string, TierSlot[]>;
  // Per-domain adblock bypass. v1 only carries the schema slot — Firecrawl
  // does not forward custom headers to the puppeteer-service, so the
  // X-Disable-Adblock signaling described in the build plan can't be wired
  // yet. Tracked in scope-creep.md.
  adblock_skip?: string[];
  profiles: Record<string, DomainProfile>;
}

export interface SearxResult {
  title: string;
  url: string;
  content?: string;
  engine?: string;
  engines?: string[];
  publishedDate?: string;
}

// SearXNG's raw JSON carries these alongside `results`. Their shapes vary a bit
// across versions (answers/corrections have been both strings and objects), so
// the raw types below are permissive and normalizeSearxMeta() collapses them.
export interface SearxResponse {
  results: SearxResult[];
  answers?: Array<string | { answer?: string; content?: string; url?: string }>;
  infoboxes?: Array<{
    infobox?: string;
    content?: string;
    urls?: Array<{ url?: string; title?: string }>;
  }>;
  corrections?: Array<string | { title?: string; url?: string }>;
  suggestions?: string[];
}

// Normalized, caller-facing shapes for the surfaced meta.
export interface SearxAnswer {
  answer: string;
  url?: string;
}

export interface SearxInfobox {
  title: string;
  content: string;
  url?: string;
}

export interface SearxMeta {
  answers: SearxAnswer[];
  infoboxes: SearxInfobox[];
  corrections: string[];
  suggestions: string[];
}

export interface SearxSearchResult {
  results: SearxResult[];
  meta: SearxMeta;
}

export interface FirecrawlScrapeResponse {
  success: boolean;
  data?: {
    markdown?: string;
    // Two spellings of one field: v2 returns `html`, v1 returns `rawHtml`,
    // matching whichever was asked for in `formats`. See
    // FirecrawlCapabilities.htmlFormat.
    html?: string;
    rawHtml?: string;
    metadata?: {
      title?: string;
      sourceURL?: string;
      // The *page's* HTTP status, distinct from the API envelope's. v2 reports
      // it; the legacy v1 backend may omit it, so absence means "unknown", not
      // "failed".
      statusCode?: number;
    };
  };
  error?: string;
}

export interface RerankResult {
  index: number;
  relevance_score: number;
}

export interface RerankResponse {
  results: RerankResult[];
}

export interface OllamaGenerateResponse {
  response: string;
}

export interface OllamaChatMessage {
  role: string;
  content: string;
}

export interface OllamaChatResponse {
  message: OllamaChatMessage;
}

export interface Citation {
  url: string;
  title: string;
  key_facts: string[];
}

/**
 * Why a synthesis was not produced. vikunja#703: an empty `summary` is reached
 * by three materially different routes and the caller could not tell them
 * apart -- nor, before v3.27.0, tell any of them from a successful synthesis.
 *
 * - `not-configured`  neither OLLAMA_URL nor LLM_BASE_URL is set. Not a
 *                     failure: summarization was never switched on.
 * - `timeout`         the request outlived OLLAMA_SUMMARIZE_TIMEOUT_MS.
 * - `llm-error`       transport failure or a non-2xx from the backend.
 * - `parse-error`     the backend answered, but not with usable JSON.
 * - `empty-response`  valid JSON whose `summary` was absent, empty, or not a
 *                     string. The model declined; nothing was broken.
 */
export type SummaryFailureKind =
  | "not-configured"
  | "timeout"
  | "llm-error"
  | "parse-error"
  | "empty-response";

export interface SummaryFailure {
  kind: SummaryFailureKind;
  detail: string;
}

export interface SummaryResult {
  summary: string;
  citations: Citation[];
  /**
   * Present if and only if `summary` is empty. Callers rendering a fallback
   * MUST surface this -- a raw-pages payload that does not announce itself
   * reads as a synthesis.
   */
  failure?: SummaryFailure;
}

export interface GitHubReadmeResponse {
  content: string;
  name: string;
  html_url: string;
}

function blankToUndefined(value: unknown): unknown {
  return value === "" || value === null ? undefined : value;
}

/**
 * An optional or defaulted tool argument for which `""` and `null` mean "not
 * given": the argument is treated as absent, so its default applies.
 *
 * Some models fill every field of a tool's schema and send `""` or `null` for
 * the ones they mean to leave out. Each of those failed validation and failed
 * the whole call: `time_range: ""` is not one of the enum values, and
 * `num_results: ""` coerced to 0, below `.min(1)` (#79). Every search from one
 * such model failed this way.
 *
 * Wrap the complete argument schema, including its `.optional()` or
 * `.default()`, and put `.describe()` on the result. zod 4 derives the
 * published JSON Schema of a preprocess from its inner schema, so the enum
 * values, default, bounds and description clients see are unchanged
 * (tests/tools-list-schema.test.ts pins them). Required arguments are never
 * wrapped, so a null `query` or `url` is still rejected.
 */
export function optionalArg<T extends z.ZodType>(schema: T) {
  return z.preprocess(blankToUndefined, schema);
}

export const CategorySchema = optionalArg(
  z.enum(["general", "news", "it", "science"]).default("general"),
);

export const TimeRangeSchema = optionalArg(
  z.enum(["day", "week", "month", "year"]).optional(),
);
