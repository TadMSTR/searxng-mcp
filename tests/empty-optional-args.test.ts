/**
 * `""` and `null` in an optional argument mean "not given" (#79).
 *
 * Some models send every field of a tool's schema and fill the ones they mean
 * to omit with `""` or `null`. Before the fix, `time_range: ""` failed the enum
 * and `num_results: ""` coerced to 0 and failed `.min(1)`, so the whole call
 * was rejected with -32602 and every search from such a model failed.
 *
 * The table below is generated from the registered tools, not written out by
 * hand: a tool or optional argument added later is covered without touching
 * this file, and one added without `optionalArg()` fails here.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  normalizeObjectSchema,
  safeParseAsync,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
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

vi.mock("../src/events.js", () => ({
  events: {
    searchRequested: vi.fn(),
    searchCompleted: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/observability.js", () => ({
  incCounter: vi.fn(),
  recordHistogram: vi.fn(),
  withSpan: vi.fn().mockImplementation((_name, _attrs, fn) => fn()),
}));

import { searxSearch } from "../src/search.js";
import { registerTools } from "../src/tools.js";

type RegisteredTools = Record<string, { inputSchema?: unknown }>;

let server: McpServer;
let client: Client;
let tools: Tool[];

beforeAll(async () => {
  server = new McpServer({ name: "searxng-mcp", version: "test" });
  registerTools(server);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  client = new Client({ name: "empty-optional-args", version: "test" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  ({ tools } = await client.listTools());
});

afterAll(async () => {
  await client.close();
  await server.close();
});

/** The zod schema the SDK validates `tools/call` arguments against. */
function registeredInputSchema(name: string) {
  // The SDK keeps no public accessor for this. The registry test below fails
  // if the field moves, rather than letting this table pass with no rows.
  const registered = (
    server as unknown as { _registeredTools: RegisteredTools }
  )._registeredTools;
  const schema = normalizeObjectSchema(
    registered?.[name]?.inputSchema as Parameters<
      typeof normalizeObjectSchema
    >[0],
  );
  if (!schema) throw new Error(`no registered input schema for ${name}`);
  return schema;
}

/** A valid value for each required argument, from its published schema. */
function requiredArgs(tool: Tool): Record<string, unknown> {
  const props = tool.inputSchema.properties ?? {};
  return Object.fromEntries(
    (tool.inputSchema.required ?? []).map((name) => {
      const prop = props[name] as { type?: string; format?: string };
      if (prop.type !== "string") {
        throw new Error(
          `${tool.name}.${name}: add a sample value for required ${prop.type}`,
        );
      }
      return [name, prop.format === "uri" ? "https://example.com/docs" : "x"];
    }),
  );
}

function optionalArgNames(tool: Tool): string[] {
  const required = new Set(tool.inputSchema.required ?? []);
  return Object.keys(tool.inputSchema.properties ?? {}).filter(
    (name) => !required.has(name),
  );
}

describe("registered tools", () => {
  it("are all reachable through the SDK registry the table reads", () => {
    expect(tools.length).toBeGreaterThanOrEqual(7);
    for (const tool of tools) {
      expect(() => registeredInputSchema(tool.name)).not.toThrow();
    }
  });

  it("have optional arguments for the table to cover", () => {
    // Guards against a table that silently loses its rows, e.g. if `required`
    // stopped being published and every argument looked required.
    const rows = tools.flatMap((tool) => optionalArgNames(tool));
    expect(rows.length).toBeGreaterThanOrEqual(30);
  });
});

describe('"" and null in an optional argument mean the argument is absent', () => {
  it("for every optional argument of every registered tool", async () => {
    const failures: string[] = [];
    for (const tool of tools) {
      const schema = registeredInputSchema(tool.name);
      const base = requiredArgs(tool);
      const absent = await safeParseAsync(schema, base);
      expect(absent.success, `${tool.name} with required args only`).toBe(true);
      for (const name of optionalArgNames(tool)) {
        for (const value of ["", null]) {
          const parsed = await safeParseAsync(schema, {
            ...base,
            [name]: value,
          });
          const label = `${tool.name}.${name} = ${JSON.stringify(value)}`;
          if (!parsed.success) {
            failures.push(`${label}: rejected`);
          } else if (
            JSON.stringify(parsed.data) !== JSON.stringify(absent.data)
          ) {
            failures.push(
              `${label}: parsed as ${JSON.stringify(parsed.data)}, not as omitted ${JSON.stringify(absent.data)}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("leaves required arguments required: a null query or url is still an error", async () => {
    for (const tool of tools) {
      const base = requiredArgs(tool);
      for (const name of Object.keys(base)) {
        const parsed = await safeParseAsync(registeredInputSchema(tool.name), {
          ...base,
          [name]: null,
        });
        expect(parsed.success, `${tool.name}.${name} = null`).toBe(false);
      }
    }
  });

  it("still rejects a non-empty invalid value", async () => {
    const parsed = await safeParseAsync(registeredInputSchema("search"), {
      query: "x",
      time_range: "fortnight",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("issue #79's payload", () => {
  it("succeeds over tools/call and searches with no time range", async () => {
    vi.mocked(searxSearch).mockClear();
    const result = await client.callTool({
      name: "search",
      arguments: {
        query: "Text search",
        expand: false,
        domain_profile: "dev",
        language: "en",
        time_range: "",
        min_score: 0.05,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(searxSearch).toHaveBeenCalled();
    const [query, category, numResults, timeRange, domainProfile, expand] =
      vi.mocked(searxSearch).mock.calls[0];
    expect({ query, category, timeRange, domainProfile, expand }).toEqual({
      query: "Text search",
      category: "general",
      timeRange: undefined,
      domainProfile: "dev",
      expand: false,
    });
    expect(numResults).toBeGreaterThanOrEqual(5);
  });
});
