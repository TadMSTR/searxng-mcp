// MCP Resources, and above all their credential guarantees.
//
// `config://searxng-mcp` is readable by every connected client — a wider
// audience than a log file, and one that includes whatever the operator has
// pointed at this server. So the assertions that matter are the negative ones:
// a secret set in the environment must not appear anywhere in the serialised
// payload, in any form.
//
// The scan at the bottom is deliberately blunt: it walks the ENTIRE serialised
// resource looking for each sentinel value, rather than checking the fields
// this test's author happened to think of. Field-by-field assertions would go
// on passing after someone adds a new field that carries a credential, which is
// exactly how this class of leak survives review.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRETS = {
  SEARXNG_MCP_AUTH_TOKEN: "sentinel-mcp-auth-token",
  FIRECRAWL_API_KEY: "sentinel-firecrawl-key",
  CRAWL4AI_API_TOKEN: "sentinel-crawl4ai-token",
  OLLAMA_API_KEY: "sentinel-ollama-key",
  HISTER_TOKEN: "sentinel-hister-token",
  GITHUB_TOKEN: "sentinel-github-token",
};
// Credentials embedded in URLs — the shape the plan called out, and the one
// that is easiest to emit by accident because the URL is otherwise useful.
const URL_PASSWORD = "sentinel-url-password";
const URL_USER = "sentineluser";

async function loadWithSecrets() {
  vi.resetModules();
  for (const [k, v] of Object.entries(SECRETS)) vi.stubEnv(k, v);
  vi.stubEnv(
    "SEARXNG_URL",
    `https://${URL_USER}:${URL_PASSWORD}@searx.example/`,
  );
  vi.stubEnv("CACHE_URL", `redis://:${URL_PASSWORD}@cache.example:6379`);
  vi.stubEnv(
    "RERANKER_URL",
    `http://${URL_USER}:${URL_PASSWORD}@reranker.example:8787`,
  );
  vi.stubEnv("OLLAMA_URL", "http://ollama.example:11434");
  vi.stubEnv("KIWIX_URL", "http://kiwix.example:8080");
  vi.stubEnv(
    "HISTER_URL",
    `https://${URL_USER}:${URL_PASSWORD}@hister.example`,
  );
  vi.stubEnv("CRAWL4AI_URL", "http://crawl4ai.example:11235");
  vi.stubEnv(
    "SOLVER_URL",
    `http://${URL_USER}:${URL_PASSWORD}@solver.example:8191`,
  );
  vi.stubEnv("SOLVER_ENABLED", "true");
  vi.stubEnv(
    "ADBLOCK_PROXY_URL",
    `http://${URL_USER}:${URL_PASSWORD}@proxy.example:8118`,
  );
  return import("../src/resources.js");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("config://searxng-mcp — credential containment", () => {
  it("leaks NO configured secret, anywhere in the serialised payload", async () => {
    const { buildConfigResource } = await loadWithSecrets();
    const serialised = JSON.stringify(buildConfigResource());

    for (const [name, value] of Object.entries(SECRETS)) {
      expect(
        serialised,
        `${name} leaked into config://searxng-mcp`,
      ).not.toContain(value);
    }
    expect(serialised, "a URL password leaked").not.toContain(URL_PASSWORD);
  });

  it("strips userinfo from every emitted endpoint while keeping the host", async () => {
    const { buildConfigResource } = await loadWithSecrets();
    const r = buildConfigResource();
    const urls = [
      ...r.endpoints.searxng,
      r.endpoints.cache,
      r.endpoints.reranker,
      r.endpoints.hister,
      r.endpoints.solver,
      r.endpoints.adblock_proxy,
    ].filter((u): u is string => typeof u === "string");

    // The control: if this list were empty the assertions below would be
    // vacuous, and every credentialed URL would be untested.
    expect(urls.length).toBeGreaterThanOrEqual(6);

    for (const u of urls) {
      expect(u, u).not.toContain(URL_PASSWORD);
      // The host must survive — a resource that redacts the whole URL answers
      // nothing, and "which backend am I wired to" is the question it exists for.
      expect(new URL(u).hostname.length, u).toBeGreaterThan(0);
    }
    expect(r.endpoints.cache).toContain("cache.example");
    expect(r.endpoints.searxng[0]).toContain("searx.example");
  });

  it("reports credentials as booleans, never as values", async () => {
    const { buildConfigResource } = await loadWithSecrets();
    const c = buildConfigResource().credentials_configured;
    for (const [k, v] of Object.entries(c)) {
      expect(typeof v, `${k} is not a boolean`).toBe("boolean");
    }
    expect(c).toEqual({
      searxng_mcp_auth_token: true,
      firecrawl_api_key: true,
      crawl4ai_api_token: true,
      ollama_api_key: true,
      hister_token: true,
      github_token: true,
    });
  });

  it("reports an UNSET credential as false even where config.ts applies a default", async () => {
    // FIRECRAWL_API_KEY defaults to "placeholder-local" in config.ts. Reading
    // the export rather than the environment would report a credential the
    // operator never set — true-looking, and wrong.
    vi.resetModules();
    for (const k of Object.keys(SECRETS)) vi.stubEnv(k, "");
    const { buildConfigResource } = await import("../src/resources.js");
    const c = buildConfigResource().credentials_configured;
    expect(Object.values(c).every((v) => v === false)).toBe(true);
  });

  // The negative control for the whole suite. If the sentinels never reached
  // the process environment, every "does not contain" assertion above would
  // pass against a payload that was never at risk.
  it("NEGATIVE CONTROL: the sentinels really are set in the environment", async () => {
    await loadWithSecrets();
    expect(process.env.FIRECRAWL_API_KEY).toBe(SECRETS.FIRECRAWL_API_KEY);
    expect(process.env.SEARXNG_URL).toContain(URL_PASSWORD);
    expect(process.env.CACHE_URL).toContain(URL_PASSWORD);
  });
});

describe("config://searxng-mcp — content", () => {
  it("carries the version and the same capability states as the startup line", async () => {
    const { buildConfigResource } = await loadWithSecrets();
    const r = buildConfigResource();
    const { capabilityStates } = await import("../src/capabilities.js");
    expect(r.name).toBe("searxng-mcp");
    expect(typeof r.version).toBe("string");
    expect(r.version.length).toBeGreaterThan(0);
    // Same source, so the resource and the startup line cannot drift apart.
    expect(r.capabilities).toEqual(capabilityStates());
  });

  it("nulls the endpoint of a disabled tier rather than advertising a dead one", async () => {
    vi.resetModules();
    vi.stubEnv("FIRECRAWL_ENABLED", "false");
    vi.stubEnv("CRAWL4AI_ENABLED", "false");
    vi.stubEnv("SOLVER_ENABLED", "false");
    const { buildConfigResource } = await import("../src/resources.js");
    const e = buildConfigResource().endpoints;
    // FIRECRAWL_URL has a non-empty default, so reporting it verbatim would
    // advertise a tier that is switched off.
    expect(e.firecrawl).toBeNull();
    expect(e.crawl4ai).toBeNull();
    expect(e.solver).toBeNull();
  });

  it("nulls an unset endpoint rather than emitting an empty string", async () => {
    vi.resetModules();
    vi.stubEnv("KIWIX_URL", "");
    vi.stubEnv("HISTER_URL", "");
    const { buildConfigResource } = await import("../src/resources.js");
    const e = buildConfigResource().endpoints;
    expect(e.kiwix).toBeNull();
    expect(e.hister).toBeNull();
  });

  it("exposes the behaviour switches an operator needs to explain a result", async () => {
    const { buildConfigResource } = await loadWithSecrets();
    const s = buildConfigResource().settings;
    expect(s).toMatchObject({
      firecrawl_enabled: expect.any(Boolean),
      firecrawl_api_version: expect.stringMatching(/^v[12]$/),
      wayback_enabled: expect.any(Boolean),
      solver_enabled: expect.any(Boolean),
      cache_ttl_seconds: expect.any(Number),
      rerank_recency_weight: expect.any(Number),
    });
  });
});

describe("stats://domains", () => {
  it("distinguishes an unreadable database from an empty one", async () => {
    // The distinction #688 exists for: a 0 that was actually an auth failure.
    vi.resetModules();
    vi.doMock("../src/domain-stats.js", () => ({
      enumerateDomains: async () => ({
        records: [],
        truncated: false,
        unavailable: "WRONGPASS invalid username-password pair",
        staleKeys: [],
      }),
      aggregateDomainStats: () => {
        throw new Error("must not aggregate when the read failed");
      },
      formatDomainAggregate: () => "",
    }));
    const { buildDomainStatsResource } = await import("../src/resources.js");
    const r = await buildDomainStatsResource();
    expect(r.available).toBe(false);
    expect(r.unavailable).toContain("WRONGPASS");
    expect(r.aggregate).toBeNull();
    // The wording matters: a caller must not read this as "no domains".
    expect(r.note).toContain("NOT a report that the database is empty");
  });

  it("returns the aggregate when the database is readable", async () => {
    vi.resetModules();
    const fakeAggregate = {
      domains_tracked: 3,
      failing_count: 1,
      truncated: false,
    };
    vi.doMock("../src/domain-stats.js", () => ({
      enumerateDomains: async () => ({
        records: [{}, {}, {}],
        truncated: false,
        unavailable: null,
        staleKeys: [],
      }),
      aggregateDomainStats: () => fakeAggregate,
      formatDomainAggregate: () => "3 domains tracked",
    }));
    const { buildDomainStatsResource } = await import("../src/resources.js");
    const r = await buildDomainStatsResource();
    expect(r.available).toBe(true);
    expect(r.unavailable).toBeNull();
    expect(r.aggregate).toEqual(fakeAggregate);
    expect(r.text).toBe("3 domains tracked");
  });

  it("surfaces truncation in the envelope, not only inside the aggregate", async () => {
    // A capped scan reported only in a nested field reads as the whole corpus
    // to anything that checks the envelope.
    vi.resetModules();
    vi.doMock("../src/domain-stats.js", () => ({
      enumerateDomains: async () => ({
        records: [{}],
        truncated: true,
        unavailable: null,
        staleKeys: [],
      }),
      aggregateDomainStats: () => ({ domains_tracked: 1, truncated: true }),
      formatDomainAggregate: () => "1 domain (TRUNCATED)",
    }));
    const { buildDomainStatsResource } = await import("../src/resources.js");
    const r = await buildDomainStatsResource();
    expect(r.available).toBe(true);
    expect(r.truncated).toBe(true);
  });

  it("an empty-but-readable database reports available: true with zero domains", async () => {
    // The other half of the #688 distinction, and the reason `available` is a
    // separate field rather than being inferred from the count.
    vi.resetModules();
    vi.doMock("../src/domain-stats.js", () => ({
      enumerateDomains: async () => ({
        records: [],
        truncated: false,
        unavailable: null,
        staleKeys: [],
      }),
      aggregateDomainStats: () => ({ domains_tracked: 0 }),
      formatDomainAggregate: () => "no domains tracked",
    }));
    const { buildDomainStatsResource } = await import("../src/resources.js");
    const r = await buildDomainStatsResource();
    expect(r.available).toBe(true);
    expect(r.aggregate).toEqual({ domains_tracked: 0 });
  });
});

describe("registerResources", () => {
  it("registers both URIs with a JSON mime type and a description", async () => {
    const {
      registerResources,
      CONFIG_RESOURCE_URI,
      DOMAIN_STATS_RESOURCE_URI,
    } = await loadWithSecrets();
    const registered: Array<{
      name: string;
      uri: string;
      config: Record<string, unknown>;
    }> = [];
    const fakeServer = {
      registerResource: (
        name: string,
        uri: string,
        config: Record<string, unknown>,
      ) => {
        registered.push({ name, uri, config });
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer surface
    registerResources(fakeServer as any);

    expect(registered.map((r) => r.uri)).toEqual([
      CONFIG_RESOURCE_URI,
      DOMAIN_STATS_RESOURCE_URI,
    ]);
    expect(CONFIG_RESOURCE_URI).toBe("config://searxng-mcp");
    expect(DOMAIN_STATS_RESOURCE_URI).toBe("stats://domains");
    for (const r of registered) {
      expect(r.config.mimeType).toBe("application/json");
      expect(String(r.config.description).length).toBeGreaterThan(40);
      expect(String(r.config.title).length).toBeGreaterThan(0);
    }
  });

  it("the config read callback returns valid JSON at the requested uri, with no secrets", async () => {
    const { registerResources, CONFIG_RESOURCE_URI } = await loadWithSecrets();
    let readCb:
      | ((uri: URL) => { contents: Array<{ uri: string; text: string }> })
      | undefined;
    const fakeServer = {
      registerResource: (
        _n: string,
        uri: string,
        _c: unknown,
        cb: (u: URL) => { contents: Array<{ uri: string; text: string }> },
      ) => {
        if (uri === CONFIG_RESOURCE_URI) readCb = cb;
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer surface
    registerResources(fakeServer as any);
    expect(readCb).toBeDefined();

    const out = readCb?.(new URL(CONFIG_RESOURCE_URI));
    expect(out?.contents).toHaveLength(1);
    const entry = out?.contents[0];
    expect(entry?.uri).toBe(new URL(CONFIG_RESOURCE_URI).href);
    const parsed = JSON.parse(String(entry?.text));
    expect(parsed.name).toBe("searxng-mcp");
    // Asserted on the WIRE FORMAT, not on the builder's return value — the
    // serialisation step is where a toJSON or a getter could reintroduce one.
    expect(String(entry?.text)).not.toContain(URL_PASSWORD);
    expect(String(entry?.text)).not.toContain(SECRETS.FIRECRAWL_API_KEY);
  });
});
