import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the options passed to connect() so we can assert the auth path chosen.
const h = vi.hoisted(() => {
  const state = { lastOpts: null as Record<string, unknown> | null };
  return { state };
});

vi.mock("@nats-io/transport-node", () => ({
  connect: async (opts: Record<string, unknown>) => {
    h.state.lastOpts = opts;
    return {
      drain: async () => {},
      publish: () => {},
    };
  },
}));

vi.mock("@nats-io/nats-core", () => ({
  credsAuthenticator: () => "creds-authenticator",
}));

const AUTH_ENV = ["NATS_URL", "NATS_USER", "NATS_PASSWORD", "NATS_CREDS"];
function clearAuthEnv() {
  for (const k of AUTH_ENV) delete process.env[k];
}

beforeEach(() => {
  vi.resetModules();
  clearAuthEnv();
  h.state.lastOpts = null;
});

afterEach(clearAuthEnv);

describe("initEvents NATS auth selection", () => {
  it("uses user/pass auth when NATS_USER and NATS_PASSWORD are set", async () => {
    process.env.NATS_URL = "nats://localhost:4222";
    process.env.NATS_USER = "searxng-mcp";
    process.env.NATS_PASSWORD = "s3cret";
    const { initEvents } = await import("../src/events.js");
    await initEvents();
    expect(h.state.lastOpts).toMatchObject({
      user: "searxng-mcp",
      pass: "s3cret",
    });
    expect(h.state.lastOpts?.authenticator).toBeUndefined();
  });

  it("does not set user/pass when only NATS_URL is configured", async () => {
    process.env.NATS_URL = "nats://localhost:4222";
    const { initEvents } = await import("../src/events.js");
    await initEvents();
    expect(h.state.lastOpts?.user).toBeUndefined();
    expect(h.state.lastOpts?.pass).toBeUndefined();
    expect(h.state.lastOpts?.authenticator).toBeUndefined();
  });

  it("does not attempt user/pass auth when NATS_PASSWORD is missing", async () => {
    process.env.NATS_URL = "nats://localhost:4222";
    process.env.NATS_USER = "searxng-mcp";
    const { initEvents } = await import("../src/events.js");
    await initEvents();
    expect(h.state.lastOpts?.user).toBeUndefined();
    expect(h.state.lastOpts?.pass).toBeUndefined();
  });
});
