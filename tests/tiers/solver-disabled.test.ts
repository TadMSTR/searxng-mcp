// The solver tier must be completely inert when unconfigured — same contract as
// WAYBACK_ENABLED. A deployment that has not opted in behaves exactly as it did
// before this tier existed, so the config mock here is the whole point of the
// separate file (vi.mock is per-module-graph).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  SOLVER_URL: "http://byparr:8191",
  SOLVER_ENABLED: false,
  SOLVER_MAX_TIMEOUT_MS: 60_000,
  ADBLOCK_PROXY_URL: null,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { solverFetch } from "../../src/tiers/solver.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("solverFetch — SOLVER_ENABLED off", () => {
  it("returns null without contacting the solver", async () => {
    expect(await solverFetch("https://example.com/page")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
