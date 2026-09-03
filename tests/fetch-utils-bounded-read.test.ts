import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RAW_HTML_MAX_BYTES,
  readBoundedText,
} from "../src/fetch-utils.js";

// A stub that streams far more than any cap the tests set, and records how
// many bytes it actually pushed onto the wire before the client went away.
// That counter is the point of the whole file: "the result was truncated" is
// equally true of an unbounded read followed by a slice, so it is not evidence
// that anything is bounded. Bytes-actually-sent is.
const OFFERED_BYTES = 40 * 1024 * 1024;
const CHUNK = Buffer.alloc(64 * 1024, "a");

let httpServer: Server;
let port: number;
let bytesSent = 0;

beforeAll(async () => {
  httpServer = createServer((_req, res) => {
    bytesSent = 0;
    res.writeHead(200, { "content-type": "text/plain" });
    let done = false;
    const stop = () => {
      done = true;
    };
    res.on("close", stop);
    res.on("error", stop);
    const pump = () => {
      while (!done && bytesSent < OFFERED_BYTES) {
        bytesSent += CHUNK.byteLength;
        if (!res.write(CHUNK)) {
          res.once("drain", pump);
          return;
        }
      }
      if (!done) res.end();
    };
    pump();
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  port = (httpServer.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    httpServer.close((err) => (err ? reject(err) : resolve())),
  );
});

// Give the server a moment to notice the cancelled socket, so bytesSent has
// settled before it is asserted on.
const settle = () => new Promise((r) => setTimeout(r, 250));

describe("readBoundedText — the bound is on the read, not on the result", () => {
  it("stops reading a huge stream: retains exactly the cap, and the server never sends the full body", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const text = await readBoundedText(res);
    await settle();

    // Hard bound on memory retained.
    expect(Buffer.byteLength(text, "utf-8")).toBe(RAW_HTML_MAX_BYTES);

    // And the read genuinely stopped. Cancellation is not instantaneous —
    // socket buffers and in-flight data mean the peer pushes some way past the
    // cap (~4 MB measured against a 2 MB cap), so this is deliberately a
    // generous ceiling rather than "sent <= the cap", which would be flaky and
    // is not what the helper promises.
    expect(bytesSent).toBeLessThan(OFFERED_BYTES / 2);
  });

  it("negative control: an unbounded res.text() on the same stub buffers the entire body", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const text = await res.text();
    await settle();

    // This is the pattern being removed from the codebase. If this assertion
    // ever fails, the stub stopped offering a body big enough to distinguish
    // the two reads, and the test above proves nothing.
    expect(Buffer.byteLength(text, "utf-8")).toBe(OFFERED_BYTES);
    expect(bytesSent).toBe(OFFERED_BYTES);
  });

  it("honours a custom limit", async () => {
    const limit = 128 * 1024;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const text = await readBoundedText(res, limit);
    await settle();

    expect(Buffer.byteLength(text, "utf-8")).toBe(limit);
    expect(bytesSent).toBeLessThan(OFFERED_BYTES / 2);
  });

  it("returns a small body unchanged and does not pad to the limit", async () => {
    const text = await readBoundedText(new Response("hello world"));
    expect(text).toBe("hello world");
  });
});

describe("readBoundedText — the no-reader path fails closed", () => {
  it("returns empty for a response with no readable stream instead of falling back to res.text()", async () => {
    // The old fallback was `(await res.text()).slice(...)` — an unbounded read
    // sitting in the fallback path of the fix. A body-less response is a 204 /
    // 304 / HEAD, which has nothing to read anyway.
    const res = new Response(null, { status: 204 });
    expect(res.body).toBeNull();
    expect(await readBoundedText(res)).toBe("");
  });

  it("does not call res.text() on the no-reader path", async () => {
    let textCalled = false;
    const fake = {
      body: null,
      text: async () => {
        textCalled = true;
        return "x".repeat(10_000_000);
      },
    } as unknown as Response;

    expect(await readBoundedText(fake)).toBe("");
    expect(textCalled).toBe(false);
  });
});

describe("readBoundedText — truncation is byte-based, not character-based", () => {
  it("truncates multi-byte content by bytes", async () => {
    // "€" is 3 bytes in UTF-8, 1 JS character. 300 of them is 900 bytes but
    // only 300 characters, so the old trailing `.slice(0, limit)` on the
    // decoded string was a no-op for any multi-byte body — it could never cut
    // anything the loop had not already bounded, and it conflated two units.
    const euros = "€".repeat(300);
    expect(Buffer.byteLength(euros, "utf-8")).toBe(900);

    const text = await readBoundedText(new Response(euros), 600);
    expect(Buffer.byteLength(text, "utf-8")).toBe(600);
    expect(text.length).toBe(200);
  });

  it("yields a replacement char rather than over-reading when the cut splits a sequence", async () => {
    const text = await readBoundedText(new Response("€€"), 4);
    // 4 bytes = one whole "€" plus the first byte of the second.
    expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(6);
    expect(text.startsWith("€")).toBe(true);
    expect(text).toContain("�");
  });

  it("a zero limit reads nothing", async () => {
    expect(await readBoundedText(new Response("plenty of content here"), 0)).toBe(
      "",
    );
  });
});
