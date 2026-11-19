// Coverage for the config-driven half of domains.ts: profile overlays, operator
// tier skips, the allowlist accessors, and the load-failure fallback.
//
// The existing domains.test.ts exercises urlMatchesDomain and blocking against
// the REAL domains.json, which is the right thing for those. It cannot reach
// the branches below, because the shipped file has an empty `tier_skip` and an
// empty `adblock_skip` — so the code that reads them has never run under test
// even though it is read on every fetch.
//
// domains.ts loads its config at module import and installs a watchFile hot
// reload, so each case mocks node:fs and re-imports rather than mutating shared
// state. watchFile is stubbed to a no-op: leaving real StatWatchers behind is
// what produces the MaxListenersExceededWarning in a full run.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearxResult } from "../src/types.js";

const h = vi.hoisted(() => ({
  state: { raw: "{}", throwOnRead: null as Error | null },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      if (h.state.throwOnRead) throw h.state.throwOnRead;
      // Only intercept the domains.json read; anything else stays real.
      if (typeof args[0] === "string" && args[0].endsWith("domains.json")) {
        return h.state.raw;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
    },
    watchFile: () => undefined,
  };
});

async function loadWith(config: unknown) {
  h.state.raw = typeof config === "string" ? config : JSON.stringify(config);
  h.state.throwOnRead = null;
  vi.resetModules();
  return import("../src/domains.js");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  h.state.throwOnRead = null;
});

const r = (url: string): SearxResult => ({ title: url, url, content: "" });

describe("domains.ts — config accessors", () => {
  it("getAdblockSkipList and getLlmsTxtAllowlist return the configured lists", async () => {
    const m = await loadWith({
      llms_txt: ["docs.example.com"],
      adblock_skip: ["bank.example"],
    });
    expect(m.getLlmsTxtAllowlist()).toEqual(["docs.example.com"]);
    expect(m.getAdblockSkipList()).toEqual(["bank.example"]);
  });

  it("both default to empty when the keys are absent", async () => {
    const m = await loadWith({ boost: [], block: [] });
    expect(m.getLlmsTxtAllowlist()).toEqual([]);
    expect(m.getAdblockSkipList()).toEqual([]);
  });

  it("a missing or malformed domains.json degrades to an empty config, not a throw", async () => {
    h.state.raw = "{ this is not json";
    vi.resetModules();
    const m = await import("../src/domains.js");
    expect(m.getBlockList()).toEqual([]);
    expect(m.getBoostList()).toEqual([]);
    expect(m.getLlmsTxtAllowlist()).toEqual([]);
    // The whole point of the empty fallback: filtering is a no-op rather than
    // the server failing to start over a config file.
    expect(m.applyDomainFilters([r("https://a.example/x")])).toHaveLength(1);
  });

  it("survives readFileSync throwing outright", async () => {
    h.state.throwOnRead = new Error("EACCES");
    vi.resetModules();
    const m = await import("../src/domains.js");
    expect(m.getBlockList()).toEqual([]);
  });
});

describe("domains.ts — profile overlays", () => {
  const CONFIG = {
    boost: ["base-boost.example"],
    block: ["base-block.example"],
    profiles: {
      dev: { boost: ["dev-boost.example"], block: ["dev-block.example"] },
      bare: {},
    },
  };

  it("no profile returns the base lists unchanged", async () => {
    const m = await loadWith(CONFIG);
    expect(m.getBoostList()).toEqual(["base-boost.example"]);
    expect(m.getBlockList()).toEqual(["base-block.example"]);
  });

  it("a known profile appends to the base rather than replacing it", async () => {
    const m = await loadWith(CONFIG);
    expect(m.getBoostList("dev")).toEqual([
      "base-boost.example",
      "dev-boost.example",
    ]);
    expect(m.getBlockList("dev")).toEqual([
      "base-block.example",
      "dev-block.example",
    ]);
  });

  it("an UNKNOWN profile falls back to the base instead of returning nothing", async () => {
    // The failure this guards against is a typo'd profile silently disabling
    // all filtering, which looks like the feature working.
    const m = await loadWith(CONFIG);
    expect(m.getBoostList("nope")).toEqual(["base-boost.example"]);
    expect(m.getBlockList("nope")).toEqual(["base-block.example"]);
  });

  it("a profile with no boost/block keys contributes nothing and does not throw", async () => {
    const m = await loadWith(CONFIG);
    expect(m.getBoostList("bare")).toEqual(["base-boost.example"]);
    expect(m.getBlockList("bare")).toEqual(["base-block.example"]);
  });

  it("boosted results float to the top, preserving order within each group", async () => {
    const m = await loadWith({
      boost: ["good.example"],
      block: [],
      profiles: {},
    });
    const out = m.applyDomainFilters([
      r("https://other.example/1"),
      r("https://good.example/1"),
      r("https://other.example/2"),
      r("https://good.example/2"),
    ]);
    expect(out.map((x) => x.url)).toEqual([
      "https://good.example/1",
      "https://good.example/2",
      "https://other.example/1",
      "https://other.example/2",
    ]);
  });
});

describe("domains.ts — operator tier skips", () => {
  it("returns nothing when tier_skip is absent", async () => {
    const m = await loadWith({ boost: [], block: [] });
    expect(m.getOperatorTierSkips("https://a.example/x")).toEqual([]);
  });

  it("returns the tiers configured for a matching domain", async () => {
    const m = await loadWith({
      tier_skip: { "slow.example": ["tier1", "tier2"] },
    });
    expect(m.getOperatorTierSkips("https://slow.example/page").sort()).toEqual([
      "tier1",
      "tier2",
    ]);
  });

  it("matches subdomains and www, like every other pattern in this file", async () => {
    const m = await loadWith({ tier_skip: { "slow.example": ["tier1"] } });
    expect(m.getOperatorTierSkips("https://cdn.slow.example/p")).toEqual([
      "tier1",
    ]);
    expect(m.getOperatorTierSkips("https://www.slow.example/p")).toEqual([
      "tier1",
    ]);
  });

  it("returns nothing for a non-matching URL", async () => {
    const m = await loadWith({ tier_skip: { "slow.example": ["tier1"] } });
    expect(m.getOperatorTierSkips("https://fast.example/p")).toEqual([]);
  });

  it("unions the tiers when several patterns match the same URL", async () => {
    const m = await loadWith({
      tier_skip: { "slow.example": ["tier1"], "slow.example/heavy": ["tier2"] },
    });
    expect(
      m.getOperatorTierSkips("https://slow.example/heavy/page").sort(),
    ).toEqual(["tier1", "tier2"]);
    // De-duplicated, not concatenated.
    const m2 = await loadWith({
      tier_skip: { "slow.example": ["tier1"], "slow.example/heavy": ["tier1"] },
    });
    expect(m2.getOperatorTierSkips("https://slow.example/heavy/p")).toEqual([
      "tier1",
    ]);
  });

  it("ignores a non-array value rather than throwing on hand-edited config", async () => {
    // tier_skip is operator-edited JSON, so a scalar where a list belongs is a
    // realistic typo. It must not take the fetch path down.
    const m = await loadWith({
      tier_skip: { "a.example": "tier1", "b.example": ["tier2"] },
    });
    expect(m.getOperatorTierSkips("https://a.example/p")).toEqual([]);
    expect(m.getOperatorTierSkips("https://b.example/p")).toEqual(["tier2"]);
  });
});

// The image shipped without domains.json until 4.0.0 and the load failure was
// silent. These pin the two log lines: the counts line CI's image smoke test
// greps for, and the warning that names the path when the file is missing.
describe("domains.ts — load logging", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });
  const lines = () => errSpy.mock.calls.map((c) => c.map(String).join(" "));

  it("logs the counts for the repo's real domains.json", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const { fileURLToPath } = await import("node:url");
    const repoFile = fileURLToPath(new URL("../domains.json", import.meta.url));
    const real = JSON.parse(actualFs.readFileSync(repoFile, "utf-8"));
    const m = await loadWith(real);
    errSpy.mockClear();
    m.loadDomainConfig(repoFile);
    expect(lines()).toEqual([
      `[searxng-mcp] domains: llms_txt=${real.llms_txt.length} boost=${real.boost.length} block=${real.block.length} profiles=${Object.keys(real.profiles).length}`,
    ]);
    // The smoke test's condition, against the shipped file.
    expect(real.llms_txt.length).toBeGreaterThan(0);
  });

  it("warns, naming the path, when the file does not exist", async () => {
    const m = await loadWith({ boost: ["kept.example"], block: [] });
    errSpy.mockClear();
    const err = Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
    });
    h.state.throwOnRead = err;
    m.loadDomainConfig("/nonexistent/domains.json");
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("WARNING");
    expect(lines()[0]).toContain("/nonexistent/domains.json");
    expect(lines()[0]).toContain("ENOENT");
    // A failed reload keeps the last good config rather than emptying it.
    expect(m.getBoostList()).toEqual(["kept.example"]);
  });

  it.each([
    [{ boost: 5 }, '"boost" is not a list of strings'],
    [{ block: ["ok", 3] }, '"block" is not a list of strings'],
    [{ llms_txt: "docs.example.com" }, '"llms_txt" is not a list of strings'],
    [{ adblock_skip: {} }, '"adblock_skip" is not a list of strings'],
    [{ profiles: [] }, '"profiles" is not an object'],
    [{ profiles: { dev: "x" } }, "a profile is not an object"],
    [
      { profiles: { dev: { boost: "x" } } },
      `a profile's "boost" is not a list of strings`,
    ],
    [{ tier_skip: ["tier1"] }, '"tier_skip" is not an object'],
  ])(
    "refuses a wrong-shaped field (%j) and keeps the previous config",
    async (bad, reason) => {
      const m = await loadWith({ boost: ["kept.example"], block: [] });
      errSpy.mockClear();
      h.state.raw = JSON.stringify(bad);
      m.loadDomainConfig("/x/domains.json");
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toContain(reason);
      // Lookups still work: the shape that used to throw at search time never loaded.
      expect(m.getBoostList("dev")).toEqual(["kept.example"]);
      expect(m.applyDomainFilters([r("https://a.example/x")])).toHaveLength(1);
    },
  );

  it("says 'not valid JSON' for a file that does not parse", async () => {
    const m = await loadWith({ boost: ["kept.example"], block: [] });
    errSpy.mockClear();
    h.state.raw = "{ half-written";
    m.loadDomainConfig("/x/domains.json");
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("not valid JSON");
    expect(m.getBoostList()).toEqual(["kept.example"]);
  });

  it("rejects a top-level null or array without corrupting the config", async () => {
    for (const bad of ["null", "[]", "42"]) {
      const m = await loadWith(bad);
      expect(lines().at(-1)).toContain("top level is not an object");
      expect(m.getBlockList()).toEqual([]);
      expect(m.applyDomainFilters([r("https://a.example/x")])).toHaveLength(1);
    }
  });
});
