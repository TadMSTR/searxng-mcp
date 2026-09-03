import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  GITHUB_TOKEN: undefined,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { RAW_HTML_MAX_BYTES } from "../src/fetch-utils.js";
import { githubFetch } from "../src/tiers/github.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const CHUNK_BYTES = 64 * 1024;

/**
 * A body stream that will keep producing forever until the consumer stops
 * pulling. This is the assertion mechanism for the whole file: an unbounded
 * read never terminates against it, so any test here that returns at all is
 * evidence that the read stopped on its own. Checking the result length would
 * not be — a bounded-looking result is equally produced by reading everything
 * and then slicing.
 */
function endlessBody(fill: string) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new TextEncoder().encode(
    fill.repeat(CHUNK_BYTES / fill.length),
  );
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

/** A stream that yields `prefix` first, then never stops. */
function endlessAfter(prefix: string) {
  const state = { pulled: 0, cancelled: false };
  const head = new TextEncoder().encode(prefix);
  const filler = new TextEncoder().encode("x".repeat(CHUNK_BYTES));
  let sentHead = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentHead) {
        sentHead = true;
        state.pulled += head.byteLength;
        controller.enqueue(head);
        return;
      }
      state.pulled += filler.byteLength;
      controller.enqueue(filler);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

function streamedResponse(
  stream: ReadableStream<Uint8Array>,
  opts?: { headers?: Record<string, string> },
) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(opts?.headers ?? {}),
    body: stream,
    text: () => {
      throw new Error(
        "res.text() must not be called — this read is supposed to be bounded",
      );
    },
    json: () => {
      throw new Error(
        "res.json() must not be called — this read is supposed to be bounded",
      );
    },
  };
}

describe("tiers/github raw content — the read is bounded, not the result", () => {
  it("stops reading raw.githubusercontent.com instead of buffering the whole file", async () => {
    const { stream, state } = endlessBody("a");
    mockFetch.mockResolvedValueOnce(streamedResponse(stream));

    const out = await githubFetch(
      "https://raw.githubusercontent.com/o/r/main/big.txt",
      8000,
    );

    // Returning at all is the result: res.text() would still be running.
    expect(out.text.length).toBe(8000);
    expect(state.cancelled).toBe(true);
    // Overshoot is bounded by one chunk, not by the size of the file offered.
    expect(state.pulled).toBeLessThanOrEqual(
      RAW_HTML_MAX_BYTES + CHUNK_BYTES * 2,
    );
  }, 30_000);
});

describe("tiers/github API — bounded before JSON.parse", () => {
  it("stops reading an api.github.com response that never ends", async () => {
    const { stream, state } = endlessAfter('{"padding":"');
    mockFetch.mockResolvedValueOnce(
      streamedResponse(stream, {
        "Content-Type": "application/json",
      }),
    );

    // The truncated body is not valid JSON, so this rejects — that is the
    // correct outcome and is not what is being asserted. What matters is that
    // it rejects *promptly*, having stopped reading, rather than never
    // returning.
    await expect(
      githubFetch("https://api.github.com/repos/o/r", 8000),
    ).rejects.toThrow();

    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(
      RAW_HTML_MAX_BYTES + CHUNK_BYTES * 2,
    );
  }, 30_000);
});
