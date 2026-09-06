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

export const CategorySchema = z
  .enum(["general", "news", "it", "science"])
  .default("general");

export const TimeRangeSchema = z
  .enum(["day", "week", "month", "year"])
  .optional();
