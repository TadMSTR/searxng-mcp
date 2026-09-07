// MCP Resources: read-only views of this server's configuration and its domain
// capability database.
//
// Resources are additive — all seven tools are unchanged. The distinction that
// makes them worth having is that a Resource is something a client can read
// WITHOUT the model deciding to call a tool, so a client can show what this
// server is wired to before spending a turn asking.
//
// ── scoped-mcp does NOT forward these ───────────────────────────────────────
//
// Verified 2026-09-07 against scoped_mcp 1.14.0, and it is not an oversight
// worth working around here: `mcp_proxy.py` touches exactly two upstream MCP
// methods, `client.list_tools()` and `client.call_tool()`. It is a tool
// RE-REGISTRATION model, not a JSON-RPC passthrough — it enumerates upstream
// tools at proxy start and synthesises one Python method per tool on its own
// FastMCP server. `grep -rln "list_resources\|read_resource"` over the whole
// scoped-mcp tree returns zero files, so there is no generic forwarding path an
// unhandled primitive could fall through.
//
// Consequence: these two Resources are reachable from direct MCP clients
// (Claude Desktop, LibreChat) and NOT from forge agents behind scoped-mcp.
// Related to but distinct from the known issue that the proxy freezes the tool
// list at start — this is a primitive that is not proxied at all.
//
// ── Credentials ────────────────────────────────────────────────────────────
//
// `config://searxng-mcp` is an ALLOWLIST, deliberately, and must stay one.
// Building it by dumping config and stripping known secrets would leak the next
// credential someone adds — and there are already seven in config.ts
// (FIRECRAWL_API_KEY, GITHUB_TOKEN, OLLAMA_API_KEY, HISTER_TOKEN,
// CRAWL4AI_API_TOKEN, SEARXNG_MCP_AUTH_TOKEN, plus any inline userinfo in
// CACHE_URL/SEARXNG_URL). Secrets are reported as a BOOLEAN — configured or
// not — and never by value.
//
// Every URL that is emitted goes through `redactUrlCredentials`, because we
// accept Basic Auth in SEARXNG_URL and forge's CACHE_URL carries an inline
// password. An unredacted config Resource hands those to every connected
// client, which is a wider audience than a log file.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { capabilityStates } from "./capabilities.js";
import {
  ADBLOCK_PROXY_URL,
  CACHE_TTL_SECONDS,
  CACHE_URL,
  CRAWL4AI_ENABLED,
  CRAWL4AI_URL,
  EXPAND_QUERIES_DEFAULT,
  FETCH_CACHE_TTL_SECONDS,
  FIRECRAWL_API_VERSION,
  FIRECRAWL_ENABLED,
  FIRECRAWL_URL,
  HISTER_URL,
  KIWIX_URL,
  LLM_BASE_URL,
  OLLAMA_EXPAND_MODEL,
  OLLAMA_SUMMARIZE_MODEL,
  OLLAMA_URL,
  RERANK_RECENCY_WEIGHT,
  RERANKER_URL,
  SEARXNG_URLS,
  SOLVER_ENABLED,
  SOLVER_URL,
  WAYBACK_ENABLED,
} from "./config.js";
import {
  aggregateDomainStats,
  enumerateDomains,
  formatDomainAggregate,
} from "./domain-stats.js";
import { redactUrlCredentials, redactUrlCredentialsInText } from "./log.js";
import { VERSION } from "./version.js";

export const CONFIG_RESOURCE_URI = "config://searxng-mcp";
export const DOMAIN_STATS_RESOURCE_URI = "stats://domains";

/** True when the env var is set to a non-empty value. Never the value itself. */
const isSet = (v: string | undefined): boolean =>
  typeof v === "string" && v.length > 0;

/** Redact an emitted URL, and collapse the empty case to null rather than "". */
const safeUrl = (u: string | null | undefined): string | null =>
  u ? redactUrlCredentials(u) : null;

/**
 * The `config://searxng-mcp` payload.
 *
 * Exported for testing so the redaction guarantees can be asserted against the
 * exact object that goes over the wire, rather than against a re-derivation of
 * it that could drift.
 */
export function buildConfigResource() {
  return {
    name: "searxng-mcp",
    version: VERSION,

    // Same source as the startup capability line, so the two cannot disagree.
    // Three states: `on` (self-contained), `unverified` (configured, never
    // contacted — nothing probes here either), `off` (not configured).
    capabilities: capabilityStates(),

    // Endpoints, credential-stripped. Present so an operator can see WHICH
    // backend is wired, which is the question this resource exists to answer.
    endpoints: {
      searxng: SEARXNG_URLS.map((u) => safeUrl(u)),
      cache: safeUrl(CACHE_URL),
      reranker: safeUrl(RERANKER_URL),
      firecrawl: FIRECRAWL_ENABLED ? safeUrl(FIRECRAWL_URL) : null,
      crawl4ai: CRAWL4AI_ENABLED ? safeUrl(CRAWL4AI_URL) : null,
      ollama: safeUrl(OLLAMA_URL),
      llm_base: safeUrl(LLM_BASE_URL),
      kiwix: safeUrl(KIWIX_URL),
      hister: safeUrl(HISTER_URL),
      solver: SOLVER_ENABLED ? safeUrl(SOLVER_URL) : null,
      adblock_proxy: safeUrl(ADBLOCK_PROXY_URL),
    },

    // Behaviour switches and tunables. No secrets here by construction.
    settings: {
      firecrawl_enabled: FIRECRAWL_ENABLED,
      firecrawl_api_version: FIRECRAWL_API_VERSION,
      crawl4ai_enabled: CRAWL4AI_ENABLED,
      wayback_enabled: WAYBACK_ENABLED,
      solver_enabled: SOLVER_ENABLED,
      expand_queries_default: EXPAND_QUERIES_DEFAULT,
      ollama_expand_model: OLLAMA_EXPAND_MODEL,
      ollama_summarize_model: OLLAMA_SUMMARIZE_MODEL,
      cache_ttl_seconds: CACHE_TTL_SECONDS,
      fetch_cache_ttl_seconds: FETCH_CACHE_TTL_SECONDS,
      rerank_recency_weight: RERANK_RECENCY_WEIGHT,
    },

    // Whether a credential is configured — NEVER its value. Read from the
    // environment directly rather than from config.ts's exports, so a default
    // applied there (FIRECRAWL_API_KEY defaults to "placeholder-local") cannot
    // report a credential the operator never set.
    credentials_configured: {
      searxng_mcp_auth_token: isSet(process.env.SEARXNG_MCP_AUTH_TOKEN),
      firecrawl_api_key: isSet(process.env.FIRECRAWL_API_KEY),
      crawl4ai_api_token: isSet(process.env.CRAWL4AI_API_TOKEN),
      ollama_api_key: isSet(process.env.OLLAMA_API_KEY),
      hister_token: isSet(process.env.HISTER_TOKEN),
      github_token: isSet(process.env.GITHUB_TOKEN),
    },
  };
}

/**
 * The `stats://domains` payload — the aggregate half of the `domain_stats`
 * tool, read-only.
 *
 * Mirrors that handler's projection deliberately, including the `unavailable`
 * branch. A read failure must NOT be reported as an empty database: those
 * produced the same answer once before, and the second is the one a reader
 * believes (vikunja#688).
 */
export async function buildDomainStatsResource() {
  const { records, truncated, unavailable } = await enumerateDomains();
  if (unavailable) {
    return {
      available: false as const,
      // Scrubbed on the way out. `unavailable` comes from
      // describeTransportFailure, which interpolates the raw `err.message` —
      // and an ioredis/undici failure can carry the connection URL, which for
      // a cache backend means an inline password. The tool path returns the
      // same string, but a Resource is readable without the model choosing to
      // call anything, so the sink is wider here.
      //
      // Redacted at the sink rather than at the throw site, which is the
      // convention log.ts already documents: error text can originate from any
      // library, and this class of leak has been introduced before by guarding
      // one path and missing the others.
      unavailable: redactUrlCredentialsInText(unavailable),
      note:
        "This is NOT a report that the database is empty — no count was " +
        "obtained. Check the cache backend is reachable and its credentials " +
        "are correct.",
      aggregate: null,
    };
  }
  const aggregate = aggregateDomainStats(records, truncated);
  return {
    available: true as const,
    unavailable: null,
    // `truncated` rides along inside the aggregate; surfaced here too so a
    // caller reading only the envelope cannot mistake a capped scan for the
    // whole corpus.
    truncated,
    aggregate,
    text: formatDomainAggregate(aggregate),
  };
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    "config",
    CONFIG_RESOURCE_URI,
    {
      title: "searxng-mcp configuration",
      description:
        "Effective configuration and capability state for this searxng-mcp instance: which backing services are wired, the three-state capability line (on/unverified/off), behaviour switches and tunables, and which credentials are configured. Credential VALUES are never included, and every URL is stripped of inline userinfo. Read-only.",
      mimeType: "application/json",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(buildConfigResource(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "domain-stats",
    DOMAIN_STATS_RESOURCE_URI,
    {
      title: "Domain capability database (aggregate)",
      description:
        "Aggregate view of the domain capability database — per-tier success rates across all tracked domains, the worst failing domains, and the seen-but-never-fetched count. Mirrors the aggregate mode of the `domain_stats` tool. Reports `available: false` with a reason when the database cannot be read, which is distinct from it being empty. Read-only.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await buildDomainStatsResource(), null, 2),
        },
      ],
    }),
  );
}
