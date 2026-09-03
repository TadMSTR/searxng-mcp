import { redactUrlCredentials } from "./log.js";
import type { TierSlot } from "./types.js";

const SEARXNG_URL_DEFAULT = "http://localhost:8081";

/**
 * Parse `SEARXNG_URL` as an ordered list of interchangeable replicas.
 *
 * Accepts both `,` and `;` as separators — neither is legal in a URL authority,
 * and the comparable server (`ihor-sokoliuk/mcp-searxng`) uses `;`, so taking
 * both avoids a silent single-instance fallback for anyone copying that syntax.
 *
 * A SCALAR VALUE MUST BEHAVE EXACTLY AS BEFORE. That is every existing
 * deployment, so it is the case this function is written around: one entry in,
 * one entry out, no health lookup, one request. See `getSearxCandidates`.
 *
 * Unparseable entries are dropped with a warning rather than taken literally.
 * An unset `${SEARXNG_URL}` in a manifest interpolates to the *literal* string
 * `"${SEARXNG_URL}"` rather than to empty, and `new URL()` is what catches it —
 * without this the server would come up and fail every search against a
 * nonsense host. If nothing survives, fall back to the default and say so
 * loudly; refusing to boot would turn one bad env var into a total outage.
 */
export function parseSearxngUrls(
  raw: string | undefined,
  warn: (msg: string) => void = () => {},
): string[] {
  const entries = (raw ?? SEARXNG_URL_DEFAULT)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const valid: string[] = [];
  for (const entry of entries) {
    try {
      const u = new URL(entry);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        warn(
          `SEARXNG_URL entry is not http(s), ignoring: ${redactUrlCredentials(entry)}`,
        );
        continue;
      }
      // Normalise away a trailing slash so `${base}/search` cannot become
      // `//search`, which some reverse proxies 404 rather than normalising.
      valid.push(u.toString().replace(/\/$/, ""));
    } catch {
      warn(
        `SEARXNG_URL entry is not a valid URL, ignoring: ${redactUrlCredentials(entry)}`,
      );
    }
  }

  // De-duplicate: a repeated instance would be retried as though it were a
  // distinct replica, burning the shared timeout budget on a host already known
  // to have just failed.
  const deduped = [...new Set(valid)];

  if (deduped.length === 0) {
    warn(
      `SEARXNG_URL had no usable entries, falling back to ${SEARXNG_URL_DEFAULT}`,
    );
    return [SEARXNG_URL_DEFAULT];
  }
  return deduped;
}

export const SEARXNG_URLS = parseSearxngUrls(process.env.SEARXNG_URL, (m) =>
  console.error(`[searxng-mcp] ${m}`),
);

/**
 * The primary instance. Retained as a named export because it is what the
 * startup capability line and any single-endpoint caller report; failover
 * iterates `SEARXNG_URLS`.
 */
export const SEARXNG_URL = SEARXNG_URLS[0];
export const FIRECRAWL_URL =
  process.env.FIRECRAWL_URL ?? "http://localhost:3002";
export const FIRECRAWL_API_KEY =
  process.env.FIRECRAWL_API_KEY ?? "placeholder-local";
export const RERANKER_URL = process.env.RERANKER_URL ?? "http://localhost:8787";
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
export const CACHE_URL =
  process.env.CACHE_URL ??
  process.env.VALKEY_URL ??
  process.env.REDIS_URL ??
  "redis://localhost:6381";
export const CACHE_TTL_SECONDS = parseInt(
  process.env.CACHE_TTL_SECONDS ?? "3600",
  10,
);
export const FETCH_CACHE_TTL_SECONDS = parseInt(
  process.env.FETCH_CACHE_TTL_SECONDS ?? "86400",
  10,
);

// Positive-integer env parse with a safe default — an invalid or non-positive
// value falls back rather than silently becoming NaN (a NaN commandTimeout would
// disable the very timeout this build adds).
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = parseInt(raw, 10);
  return Number.isNaN(v) || v <= 0 ? fallback : v;
}

// Valkey cache client resilience (see src/cache.ts). A CPU-spiked dragonfly
// still answers its ping healthcheck but stalls on real commands; cacheGet() is
// the first await in every search, so with no command timeout it hangs until the
// MCP host's 300s idle-abort. These bound the hang; the cache stays fail-soft
// (timeout → cache miss → serve live, never throw).
export const CACHE_COMMAND_TIMEOUT_MS = positiveIntEnv(
  "CACHE_COMMAND_TIMEOUT_MS",
  2500,
);
export const CACHE_CONNECT_TIMEOUT_MS = positiveIntEnv(
  "CACHE_CONNECT_TIMEOUT_MS",
  3000,
);
// SearXNG failover tuning. Named to match the CACHE_*_TIMEOUT_MS convention
// above, and defaulted so a single-instance deployment is bit-identical to the
// pre-failover `AbortSignal.timeout(10000)`: one candidate, budget 10s,
// per-attempt ceiling 10s, so exactly one 10s-bounded request.
//
// TOTAL is the whole-call budget, not per instance. Iterating N candidates at
// 10s each would make the worst case N*10s with no ceiling — the caller would
// see a search that hangs longer the more replicas you configure, which is the
// opposite of what adding replicas is for.
export const SEARXNG_TOTAL_TIMEOUT_MS = positiveIntEnv(
  "SEARXNG_TOTAL_TIMEOUT_MS",
  10_000,
);
export const SEARXNG_ATTEMPT_TIMEOUT_MS = positiveIntEnv(
  "SEARXNG_ATTEMPT_TIMEOUT_MS",
  10_000,
);
// How long a failed instance is deprioritised for. Short by design: this is a
// hint to reorder candidates, not a circuit breaker. An instance that recovers
// should be picked up again quickly, and a stale marker must never be able to
// take a healthy instance out of rotation for long.
export const SEARXNG_UNHEALTHY_TTL_SECONDS = positiveIntEnv(
  "SEARXNG_UNHEALTHY_TTL_SECONDS",
  30,
);

export const CACHE_MAX_RETRIES_PER_REQUEST = positiveIntEnv(
  "CACHE_MAX_RETRIES_PER_REQUEST",
  2,
);
export const OLLAMA_URL = process.env.OLLAMA_URL ?? "";
export const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY ?? "";
export const OLLAMA_EXPAND_MODEL =
  process.env.OLLAMA_EXPAND_MODEL ?? "qwen3:4b";
export const OLLAMA_SUMMARIZE_MODEL =
  process.env.OLLAMA_SUMMARIZE_MODEL ?? "qwen3:14b";
// OpenAI-compatible chat backend for expand + summarize (vLLM, llama.cpp, LM
// Studio, etc.). When LLM_BASE_URL is set it takes precedence over the Ollama
// endpoint, so an already-loaded chat model can be reused instead of running a
// separate Ollama model. LLM_MODEL overrides the per-capability model names.
// LLM_DISABLE_THINKING (default on) sends `chat_template_kwargs.enable_thinking:
// false` so reasoning models (e.g. Qwen3) return direct output; set it to
// "false" for servers that reject that field.
export const LLM_BASE_URL = (process.env.LLM_BASE_URL ?? "").replace(/\/$/, "");
export const LLM_MODEL = process.env.LLM_MODEL ?? "";
export const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
export const LLM_DISABLE_THINKING =
  process.env.LLM_DISABLE_THINKING !== "false";
export const EXPAND_QUERIES_DEFAULT = process.env.EXPAND_QUERIES === "true";
export const KIWIX_URL = process.env.KIWIX_URL?.replace(/\/$/, "") ?? "";
export const HISTER_URL = process.env.HISTER_URL?.replace(/\/$/, "") ?? "";
export const HISTER_TOKEN = process.env.HISTER_TOKEN ?? "";
export const CRAWL4AI_URL = process.env.CRAWL4AI_URL ?? null;
export const CRAWL4AI_API_TOKEN = process.env.CRAWL4AI_API_TOKEN;
// Fetch-tier kill switches. Only SearXNG is genuinely required — tier 3 is an
// in-process raw fetch + Readability, so a deployment with no Firecrawl and no
// Crawl4AI still serves fetch_url. These switches let such a deployment say so,
// and the tier is then skipped as `not_configured` rather than attempted and
// missed (see computeTierSkips in routing.ts).
//
// They default to *true* and are read as `!== "false"`, matching
// YOUTUBE_TRANSCRIPT_ENABLED / REDDIT_FASTPATH_ENABLED. Deliberately NOT
// derived from whether FIRECRAWL_URL was explicitly set: it defaults to
// http://localhost:3002, so an instance already running Firecrawl on the
// default port without an env var would silently lose tier 1. An explicit
// switch is behaviour-neutral by construction.
export const FIRECRAWL_ENABLED = process.env.FIRECRAWL_ENABLED !== "false";
export const CRAWL4AI_ENABLED = process.env.CRAWL4AI_ENABLED !== "false";
/**
 * Effective per-tier availability, derived from the switches above and the URL
 * each one gates. Single source of truth: the `not_configured` skips in
 * routing.ts and the startup capability line in index.ts both read this, so
 * they cannot disagree about what is on.
 *
 * Reports *configuration*, never reachability — nothing here probes a service.
 * Tier 3 is in-process (raw fetch + Readability) and so is always available.
 */
export function tierConfigured(): Record<TierSlot, boolean> {
  return {
    tier1: FIRECRAWL_ENABLED,
    tier2: CRAWL4AI_ENABLED && Boolean(CRAWL4AI_URL),
    tier3: true,
  };
}
export const WAYBACK_ENABLED = process.env.WAYBACK_ENABLED === "true";
// Challenge-solving tier. SOLVER_URL points at a FlareSolverr-v1-compatible
// solver — Byparr on forge (`http://byparr:8191`); FlareSolverr itself speaks
// the same POST /v1 contract, so swapping is config, not code.
//
// SOLVER_ENABLED is the kill switch and defaults off, mirroring
// WAYBACK_ENABLED: with it unset the tier is inert and the cascade behaves
// exactly as it did before. The solver is also only ever reached when a tier
// actually reported `challenge_detected` — see the gate in fetchPage.
//
// Note the solver's own address is an internal service name, so the call to it
// deliberately does not go through safeFetch's public-address guard. That guard
// belongs on the *replay*, which is an outbound fetch to the caller's URL.
export const SOLVER_URL = process.env.SOLVER_URL?.replace(/\/$/, "") ?? "";
export const SOLVER_ENABLED = process.env.SOLVER_ENABLED === "true";
export const SOLVER_MAX_TIMEOUT_MS = positiveIntEnv(
  "SOLVER_MAX_TIMEOUT_MS",
  60_000,
);
// Durable domain-db snapshots (written by the domain-db-maintenance job,
// re-seeded by restore-domain-db). DOMAIN_DB_SNAPSHOT_DIR is where dated JSON
// snapshots live — set it to a durable path in deployment (e.g. an appdata or
// NFS mount); defaults to a repo-local dir so the CLIs run without config.
// DOMAIN_DB_SNAPSHOT_RETENTION is how many snapshots to keep (older pruned).
export const DOMAIN_DB_SNAPSHOT_DIR =
  process.env.DOMAIN_DB_SNAPSHOT_DIR ?? "./domain-db-snapshots";
export const DOMAIN_DB_SNAPSHOT_RETENTION = (() => {
  const v = parseInt(process.env.DOMAIN_DB_SNAPSHOT_RETENTION ?? "14", 10);
  return Number.isNaN(v) || v < 1 ? 14 : v;
})();
export const ADBLOCK_PROXY_URL = process.env.ADBLOCK_PROXY_URL ?? null;
// YouTube transcript fast path (unofficial timedtext endpoint — no SLA).
// *_ENABLED is the feature kill switch. *_IGNORE_ROBOTS lets the operator opt
// into fetching the transcript, which lives under YouTube's robots-disallowed
// /api/ path; default false = respect robots (fast path stays dormant).
export const YOUTUBE_TRANSCRIPT_ENABLED =
  process.env.YOUTUBE_TRANSCRIPT_ENABLED !== "false";
export const YOUTUBE_IGNORE_ROBOTS =
  process.env.YOUTUBE_IGNORE_ROBOTS === "true";
// Reddit fast path (public .json endpoint). Reddit's robots.txt currently
// disallows all crawlers, so the fast path stays dormant unless the operator
// opts into REDDIT_IGNORE_ROBOTS on their own instance.
export const REDDIT_FASTPATH_ENABLED =
  process.env.REDDIT_FASTPATH_ENABLED !== "false";
export const REDDIT_IGNORE_ROBOTS = process.env.REDDIT_IGNORE_ROBOTS === "true";
export const TRANSPORT = process.env.SEARXNG_MCP_TRANSPORT ?? "stdio"; // "stdio" | "http"
export const HTTP_PORT = parseInt(process.env.SEARXNG_MCP_PORT ?? "3001", 10);
export const HTTP_HOST = process.env.SEARXNG_MCP_HOST ?? "127.0.0.1";
// Optional bearer token for the HTTP transport. Empty (the default) disables the
// check entirely, so stdio users and existing loopback-bound HTTP deployments are
// unaffected. Set it whenever HTTP_HOST is not loopback — binding 0.0.0.0 (e.g.
// inside a container, so the service resolves by name) removes the only control
// that was protecting an otherwise unauthenticated `fetch_url` / `clear_cache`.
// `GET /health` is deliberately exempt: it is the container healthcheck and
// carries no secrets. See README "HTTP transport authentication".
export const HTTP_AUTH_TOKEN = process.env.SEARXNG_MCP_AUTH_TOKEN ?? "";

/**
 * True when `host` only accepts connections from this machine. Used by the
 * startup guard to decide whether an unset SEARXNG_MCP_AUTH_TOKEN is a problem.
 *
 * Wildcard binds (`0.0.0.0`, `::`) are deliberately NOT loopback — they are the
 * containerised case, and the case that needs the token. IPv6 hosts may arrive
 * bracketed from a URL-shaped config value.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}
// Bound the HTTP transport session map. Sessions are normally removed on
// transport.onclose, but an agent killed mid-turn never fires it, leaking the
// transport + its MCP server. Idle sessions are swept after this timeout, and a
// hard cap evicts the least-recently-used session if the map ever grows past it.
export const HTTP_SESSION_IDLE_TIMEOUT_MS = positiveIntEnv(
  "HTTP_SESSION_IDLE_TIMEOUT_MS",
  600_000,
);
export const HTTP_MAX_SESSIONS = positiveIntEnv("HTTP_MAX_SESSIONS", 256);
export const CRAWL_MANIFEST_TTL_SECONDS = parseInt(
  process.env.CRAWL_MANIFEST_TTL_SECONDS ?? "21600",
  10,
);
export const CRAWL_MAX_PAGES_DEFAULT = parseInt(
  process.env.CRAWL_MAX_PAGES_DEFAULT ?? "20",
  10,
);
export const CRAWL_BFS_ENABLED = process.env.CRAWL_BFS_ENABLED === "true";
export const CRAWL_BFS_MAX_DEPTH = parseInt(
  process.env.CRAWL_BFS_MAX_DEPTH ?? "3",
  10,
);
export const FIRECRAWL_CRAWL_POLL_INTERVAL_MS = parseInt(
  process.env.FIRECRAWL_CRAWL_POLL_INTERVAL_MS ?? "2000",
  10,
);
export const FIRECRAWL_CRAWL_MAX_WAIT_MS = parseInt(
  process.env.FIRECRAWL_CRAWL_MAX_WAIT_MS ?? "120000",
  10,
);

export const RERANK_RECENCY_WEIGHT = (() => {
  const v = parseFloat(process.env.RERANK_RECENCY_WEIGHT ?? "0.15");
  if (Number.isNaN(v) || v < 0) {
    console.warn(
      `[searxng-mcp] RERANK_RECENCY_WEIGHT="${process.env.RERANK_RECENCY_WEIGHT}" is invalid; recency weighting disabled.`,
    );
    return 0;
  }
  if (v > 1) {
    console.warn(
      `[searxng-mcp] RERANK_RECENCY_WEIGHT=${v} exceeds 1.0; recency may dominate relevance scores.`,
    );
  }
  return v;
})();
