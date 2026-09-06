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
  it("reports a bare deployment as tier3 on, the rest unverified or off", async () => {
    const { capabilityLine } = await import("../src/capabilities.js");
    expect(capabilityLine()).toBe(
      "capabilities on=tier3 unverified=tier1,cache,reranker " +
        "off=tier2,llm,kiwix,hister,solver,wayback,otel,nats",
    );
  });

  it("moves tier1 to off when Firecrawl is switched off", async () => {
    process.env.FIRECRAWL_ENABLED = "false";
    const { capabilityLine } = await import("../src/capabilities.js");
    expect(capabilityLine()).toContain("on=tier3 unverified=cache,reranker");
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

  // vikunja#695. The line said `reranker` was on for the whole of a 4.5h
  // reranker outage, because a URL was set the entire time. `Boolean(URL)` is
  // a statement about configuration and was being rendered as a statement
  // about health. These two assertions are the ones that would have caught it.
  it("never reports a configured-but-uncontacted backend as on", async () => {
    process.env.KIWIX_URL = "http://kiwix:8080";
    process.env.LLM_BASE_URL = "http://llm:8000/v1";
    process.env.SOLVER_URL = "http://byparr:8191";
    process.env.SOLVER_ENABLED = "true";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel:4318";
    process.env.NATS_URL = "nats://nats:4222";
    const { capabilityStates } = await import("../src/capabilities.js");
    const states = capabilityStates();
    for (const backed of [
      "tier1",
      "cache",
      "reranker",
      "llm",
      "kiwix",
      "solver",
      "otel",
      "nats",
    ]) {
      expect(states[backed], `${backed} is backed by a remote dependency`).toBe(
        "unverified",
      );
    }
  });

  it("reports only the capabilities that need no backend as on", async () => {
    process.env.WAYBACK_ENABLED = "true";
    const { capabilityStates } = await import("../src/capabilities.js");
    const states = capabilityStates();
    const on = Object.keys(states).filter((k) => states[k] === "on");
    // tier3 is in-process; wayback is a plain feature flag. Anything else
    // appearing here is claiming health it has not established.
    expect(on.sort()).toEqual(["tier3", "wayback"]);
  });

  // The fix has to apply to every capability derived from a URL, not just the
  // one whose outage prompted it — fixing `reranker` and leaving `cache` is
  // exactly how this class has survived three releases.
  it("applies the distinction to every capability, not just reranker", async () => {
    const { capabilities, capabilityStates } = await import(
      "../src/capabilities.js"
    );
    const configured = capabilities();
    const states = capabilityStates();
    expect(Object.keys(states).sort()).toEqual(Object.keys(configured).sort());
    for (const [name, isConfigured] of Object.entries(configured)) {
      expect(states[name] === "off").toBe(!isConfigured);
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
