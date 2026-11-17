/**
 * Boolean tool arguments accept a real boolean and the exact strings "true"
 * and "false", and reject every other value.
 *
 * 3.31.0 parsed these with `z.coerce.boolean()`, which is `Boolean(input)`:
 * every non-empty string became `true`, so `same_domain_only: "false"` kept
 * the crawl on one domain and `expand: "false"` turned query expansion on.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  normalizeObjectSchema,
  safeParseAsync,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/cache.js", () => ({
  cacheClear: vi.fn().mockResolvedValue(0),
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheAtomicUpdate: vi.fn().mockResolvedValue(undefined),
  getValkey: vi.fn().mockResolvedValue(null),
  searchCacheKey: vi.fn().mockReturnValue("key"),
}));

vi.mock("../src/search.js", () => ({
  searxSearch: vi.fn().mockResolvedValue({
    results: [
      { title: "Result", url: "https://example.com/1", content: "content" },
    ],
    meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
  }),
}));

vi.mock("../src/reranker.js", () => ({
  rerankWithFallback: vi
    .fn()
    .mockImplementation((_, results) => Promise.resolve(results)),
}));

vi.mock("../src/crawl.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/crawl.js")>()),
  crawlSite: vi.fn().mockResolvedValue({
    strategy: "sitemap",
    base_url: "https://example.com/",
    page_count: 0,
    pages: [],
    cached: false,
  }),
}));

vi.mock("../src/events.js", () => ({
  events: {
    searchRequested: vi.fn(),
    searchCompleted: vi.fn(),
    crawlRequested: vi.fn(),
    crawlCompleted: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/observability.js", () => ({
  incCounter: vi.fn(),
  recordHistogram: vi.fn(),
  withSpan: vi.fn().mockImplementation((_name, _attrs, fn) => fn()),
}));

import { crawlSite } from "../src/crawl.js";
import { searxSearch } from "../src/search.js";
import { registerTools } from "../src/tools.js";

let server: McpServer;
let client: Client;

beforeAll(async () => {
  server = new McpServer({ name: "searxng-mcp", version: "test" });
  registerTools(server);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  client = new Client({ name: "boolean-args", version: "test" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

/** The zod schema the SDK validates `tools/call` arguments against. */
function registeredInputSchema(name: string) {
  const registered = (
    server as unknown as {
      _registeredTools: Record<string, { inputSchema?: unknown }>;
    }
  )._registeredTools;
  const schema = normalizeObjectSchema(
    registered?.[name]?.inputSchema as Parameters<
      typeof normalizeObjectSchema
    >[0],
  );
  if (!schema) throw new Error(`no registered input schema for ${name}`);
  return schema;
}

// Every boolean argument, with a valid value for its tool's required ones and
// the value the argument takes when it is not given.
const BOOLEAN_ARGS = [
  { tool: "search", arg: "expand", base: { query: "x" }, absent: undefined },
  {
    tool: "search_and_fetch",
    arg: "expand",
    base: { query: "x" },
    absent: undefined,
  },
  {
    tool: "search_and_summarize",
    arg: "expand",
    base: { query: "x" },
    absent: undefined,
  },
  {
    tool: "crawl_site",
    arg: "same_domain_only",
    base: { url: "https://example.com/docs" },
    absent: true,
  },
] as const;

describe.each(BOOLEAN_ARGS)("$tool $arg", ({ tool, arg, base, absent }) => {
  it.each([
    [true, true],
    [false, false],
    ["true", true],
    ["false", false],
    ["FALSE", false],
    [" True ", true],
    ["", absent],
    [null, absent],
  ])("accepts %j as %j", async (value, expected) => {
    const parsed = await safeParseAsync(registeredInputSchema(tool), {
      ...base,
      [arg]: value,
    });
    expect(parsed.success).toBe(true);
    expect((parsed.data as Record<string, unknown>)[arg]).toBe(expected);
  });

  it("takes its default when absent", async () => {
    const parsed = await safeParseAsync(registeredInputSchema(tool), base);
    expect(parsed.success).toBe(true);
    expect((parsed.data as Record<string, unknown>)[arg]).toBe(absent);
  });

  it.each(["0", "1", "yes", "maybe", 0, 1])("rejects %j", async (value) => {
    const parsed = await safeParseAsync(registeredInputSchema(tool), {
      ...base,
      [arg]: value,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("over tools/call", () => {
  it('crawl_site with same_domain_only: "false" reaches the crawler as false', async () => {
    const result = await client.callTool({
      name: "crawl_site",
      arguments: { url: "https://example.com/docs", same_domain_only: "false" },
    });
    expect(result.isError).toBeFalsy();
    expect(vi.mocked(crawlSite).mock.calls.at(-1)?.[2]).toBe(false);
  });

  it('search with expand: "false" does not expand', async () => {
    const result = await client.callTool({
      name: "search",
      arguments: { query: "x", expand: "false" },
    });
    expect(result.isError).toBeFalsy();
    expect(vi.mocked(searxSearch).mock.calls.at(-1)?.[5]).toBe(false);
  });
});
