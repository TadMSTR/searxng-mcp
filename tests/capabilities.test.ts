// The startup capability line. It is the operator's answer to "why is quality
// worse than I expected", so the thing worth testing is that it reports
// configuration honestly — and, in particular, that it never probes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CAP_ENV = [
  "FIRECRAWL_ENABLED",
  "CRAWL4AI_ENABLED",
  "CRAWL4AI_URL",
  "KIWIX_URL",
  "HISTER_URL",
  "LLM_BASE_URL",
  "OLLAMA_URL",
  "SOLVER_URL",
  "SOLVER_ENABLED",
  "WAYBACK_ENABLED",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "NATS_URL",
  "HISTER_TOKEN",
];

function clearCapEnv() {
  for (const k of CAP_ENV) delete process.env[k];
}

beforeEach(() => {
  vi.resetModules();
  clearCapEnv();
});

afterEach(clearCapEnv);

describe("capabilityLine", () => {
  it("reports a bare deployment as tier3 + cache + reranker only", async () => {
    const { capabilityLine } = await import("../src/capabilities.js");
    expect(capabilityLine()).toBe(
      "capabilities on=tier1,tier3,cache,reranker " +
        "off=tier2,llm,kiwix,hister,solver,wayback,otel,nats",
    );
  });

  it("moves tier1 to off when Firecrawl is switched off", async () => {
    process.env.FIRECRAWL_ENABLED = "false";
    const { capabilityLine } = await import("../src/capabilities.js");
    expect(capabilityLine()).toContain("on=tier3,cache,reranker");
    expect(capabilityLine()).toMatch(/off=tier1,tier2,/);
  });

  it("stays a single line however many capabilities are on", async () => {
    process.env.CRAWL4AI_URL = "http://crawl4ai:11235";
    process.env.KIWIX_URL = "http://kiwix:8080";
    process.env.HISTER_URL = "http://hister:8080";
    process.env.LLM_BASE_URL = "http://llm:8000/v1";
    process.env.SOLVER_URL = "http://byparr:8191";
    process.env.SOLVER_ENABLED = "true";
    process.env.WAYBACK_ENABLED = "true";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel:4318";
    process.env.NATS_URL = "nats://nats:4222";
    const { capabilityLine } = await import("../src/capabilities.js");
    const line = capabilityLine();
    expect(line).not.toContain("\n");
    expect(line).toContain("off=none");
  });

  // A configured solver still needs its switch, matching the cascade's own
  // gate — reporting it on from the URL alone would misdescribe the deployment.
  it("reports the solver off when its URL is set but the switch is not", async () => {
    process.env.SOLVER_URL = "http://byparr:8191";
    const { capabilityLine } = await import("../src/capabilities.js");
    expect(capabilityLine()).toMatch(/off=.*solver/);
  });

  // The line must be derivable with every optional service dead, so it can
  // never delay or fail startup. If it probed, this would hang or throw.
  it("does not touch the network", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("no network in this test"));
    const { capabilityLine } = await import("../src/capabilities.js");
    expect(capabilityLine()).toContain("capabilities on=");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  // The line is built from Object.keys of a record whose values are already
  // collapsed to booleans, so no URL or credential can reach it. That is a
  // security property of the construction rather than of a redaction step, and
  // it would regress silently if the line were ever "improved" to show where
  // each service points — hence an explicit test rather than a comment.
  it("emits no URL, host or credential from any configured service", async () => {
    process.env.HISTER_URL = "http://hister.internal.example:8080";
    process.env.HISTER_TOKEN = "s3cret-hister-token";
    process.env.LLM_BASE_URL = "http://llm.internal.example:8000/v1";
    process.env.KIWIX_URL = "http://kiwix.internal.example:8292";
    process.env.SOLVER_URL = "http://byparr.internal.example:8191";
    process.env.NATS_URL = "nats://user:pw@nats.internal.example:4222";
    const { capabilityLine } = await import("../src/capabilities.js");
    const line = capabilityLine();
    for (const leak of [
      "internal.example",
      "s3cret-hister-token",
      "://",
      "8080",
      "user:pw",
    ]) {
      expect(line).not.toContain(leak);
    }
  });

  it("agrees with tierConfigured about the tiers", async () => {
    process.env.FIRECRAWL_ENABLED = "false";
    const { capabilities } = await import("../src/capabilities.js");
    const { tierConfigured } = await import("../src/config.js");
    const caps = capabilities();
    const tiers = tierConfigured();
    expect({
      tier1: caps.tier1,
      tier2: caps.tier2,
      tier3: caps.tier3,
    }).toEqual(tiers);
  });
});
