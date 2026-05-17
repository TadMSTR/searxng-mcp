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

export interface SearxResponse {
  results: SearxResult[];
}

export interface FirecrawlScrapeResponse {
  success: boolean;
  data?: {
    markdown?: string;
    html?: string;
    metadata?: {
      title?: string;
      sourceURL?: string;
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

export interface SummaryResult {
  summary: string;
  citations: Citation[];
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
