import { z } from "zod";

export interface DomainProfile {
  boost?: string[];
  block?: string[];
}

export interface DomainConfig {
  boost: string[];
  block: string[];
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
