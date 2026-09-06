import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted — runs before imports, so CRAWL4AI_URL is set correctly
vi.mock("../../src/config.js", () => ({
  CRAWL4AI_URL: "http://crawl4ai:8000",
  CRAWL4AI_API_TOKEN: undefined,
  ADBLOCK_PROXY_URL: null,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { crawl4aiFetch, pollCrawl4aiTask } from "../../src/tiers/crawl4ai.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const URL = "https://example.com/page";

// Real Response so crawl4aiFetch's readBoundedText(resp) has a body to read.
const syncResponse = (text = "# Page Content\n\nSome text") =>
  new Response(
    JSON.stringify({
      results: [
        {
          markdown: { raw_markdown: text },
          metadata: { title: "Page Title" },
          html: "<p>html</p>",
        },
      ],
    }),
    { status: 200 },
  );

describe("crawl4aiFetch", () => {
  it("returns result immediately on synchronous response", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse());
    const result = await crawl4aiFetch(URL);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Page Title");
    expect(result?.text).toContain("Some text");
  });

  it("truncates text to maxChars", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse("abcdefghij"));
    const result = await crawl4aiFetch(URL, 3);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("abc");
  });

  it("returns null when sync result has empty markdown", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse(""));
    const result = await crawl4aiFetch(URL);
    expect(result).toBeNull();
  });

  it("refuses an invalid task_id format (path traversal guard)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ task_id: "../../etc/passwd" }), {
        status: 200,
      }),
    );
    // Still refused; it now reports rather than passing for an empty page.
    await expect(crawl4aiFetch(URL)).rejects.toThrow(/malformed task_id/);
    // The guard's whole point: the traversal path is never requested.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // Previously asserted `null` here. A non-2xx is the backend refusing the
  // crawl, and booking that as an empty result is what hid a 100% tier outage
  // (vikunja#690, the concrete instance of #687).
  it("throws when response is not-ok", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "boom" }), { status: 500 }),
    );
    await expect(crawl4aiFetch(URL)).rejects.toThrow(/Crawl4AI error: 500/);
  });

  it("leads the reason with the net::ERR_ token so a bound cannot cut it off", async () => {
    // Shape captured from the live 0.8.6 response to #690's probe: the
    // diagnostic token sits ~200 chars into a Python traceback, exactly where
    // a head-truncated relay loses it.
    const detail =
      "Crawl request failed: Unexpected error in _crawl_web at line 778 in " +
      "_crawl_web (../usr/local/lib/python3.12/site-packages/crawl4ai/" +
      "async_crawler_strategy.py):\nError: Failed on navigating ACS-GOTO:\n" +
      "Page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://example.com/";
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ detail }), { status: 500 }),
    );

    const err = (await crawl4aiFetch(URL).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("net::ERR_PROXY_CONNECTION_FAILED");
    // And it survives the 200-char bound applied at the fetch boundary.
    expect(err.message.slice(0, 200)).toContain(
      "net::ERR_PROXY_CONNECTION_FAILED",
    );
  });

  it("throws on a transport failure rather than reporting an empty page", async () => {
    // Connection reset / DNS failure / TLS rejection all arrive this way —
    // including the tokenless crawl4ai 0.9.x mode that reports healthy.
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(crawl4aiFetch(URL)).rejects.toThrow(/fetch failed/);
  });

  it("names the transport failure code, not just 'fetch failed'", async () => {
    // Node reports every transport failure as the bare string "fetch failed"
    // and puts the actionable part on cause.code. ECONNRESET specifically is
    // how a tokenless crawl4ai 0.9.x presents while reporting healthy.
    mockFetch.mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNRESET" },
      }),
    );
    await expect(crawl4aiFetch(URL)).rejects.toThrow(
      /Crawl4AI unreachable: ECONNRESET/,
    );
  });

  it("falls back to the cause message when there is no code", async () => {
    // Observed live: Node rejects a request to a blocked port with a cause
    // that has a message and no code. Asserting only the code branch would
    // have passed while the real path produced a bare "fetch failed".
    mockFetch.mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), {
        cause: { message: "bad port" },
      }),
    );
    await expect(crawl4aiFetch(URL)).rejects.toThrow(
      /Crawl4AI unreachable: bad port/,
    );
  });

  it("omits crawler_config from the request body by default", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse());
    await crawl4aiFetch(URL);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.crawler_config).toBeUndefined();
  });

  it("maps selectors into crawler_config (css_selector + wait_for)", async () => {
    mockFetch.mockResolvedValueOnce(syncResponse());
    await crawl4aiFetch(URL, 8000, false, {
      targetSelector: "main",
      waitForSelector: "#ready",
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.crawler_config).toEqual({
      css_selector: "main",
      wait_for: "css:#ready",
    });
  });
});

describe("pollCrawl4aiTask", () => {
  it("returns result when status is completed", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "completed",
          result: {
            markdown: { raw_markdown: "page content" },
            metadata: { title: "Polled Page" },
            html: null,
          },
        }),
        { status: 200 },
      ),
    );

    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = pollCrawl4aiTask("task123", URL, 8000, controller.signal);
    // Advance past the initial 2s sleep
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    vi.useRealTimers();

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Polled Page");
    expect(result?.text).toBe("page content");
  });

  // Previously asserted `null`. A failed job is the backend saying it could
  // not crawl the page — on an async backend, #690's proxy failure arrives
  // exactly here — so it must not be recorded as "attempted, no content".
  it("throws when status is failed, carrying the job's own error", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "failed",
          error:
            "Page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://example.com/",
        }),
        { status: 200 },
      ),
    );

    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = pollCrawl4aiTask("task123", URL, 8000, controller.signal);
    const settled = expect(promise).rejects.toThrow(
      /net::ERR_PROXY_CONNECTION_FAILED/,
    );
    await vi.advanceTimersByTimeAsync(2500);
    await settled;
    vi.useRealTimers();
  });

  it("throws when aborted — the only signal here is our own 45s deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const promise = pollCrawl4aiTask("task123", URL, 8000, controller.signal);
    const settled = expect(promise).rejects.toThrow(/Crawl4AI timeout/);
    // abort check runs after the 2s sleep, so advance past it
    await vi.advanceTimersByTimeAsync(2500);
    await settled;
    vi.useRealTimers();
  });

  it("throws when the job never reaches a terminal state in the budget", async () => {
    // A fresh Response per poll — one instance would have its body stream
    // locked after the first read and fail for the wrong reason.
    mockFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ status: "processing" }), { status: 200 }),
    );

    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = pollCrawl4aiTask("task123", URL, 8000, controller.signal);
    const settled = expect(promise).rejects.toThrow(/poll deadline exceeded/);
    await vi.advanceTimersByTimeAsync(45_000);
    await settled;
    vi.useRealTimers();
  });
});

/**
 * The fallthrough at the end of crawl4aiFetch's try block.
 *
 * v3.25.0 fixed the tier's transport handling for vikunja#690/#687, but this
 * path survived: a 200 carrying neither `results` nor a `task_id` returned
 * `null`, and runTier books null as `empty_result` — the exact conflation that
 * ticket existed to remove, one branch below the code that removed it.
 *
 * A backend answering 200 in a shape we do not recognise is a version skew or
 * something else replying in its place (a proxy error page, an auth portal).
 * It is not an empty page.
 */
describe("crawl4aiFetch on an unrecognised 200", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws rather than reporting the page as empty", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok", detail: "nothing here" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(crawl4aiFetch(URL)).rejects.toThrow(
      /unrecognised response shape/i,
    );
  });

  it("still treats an empty results array as a genuine empty answer", async () => {
    // The negative control. `results: []` IS the backend telling us it found
    // nothing, and must keep returning null — otherwise this fix converts a
    // real empty result into a tier error.
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(crawl4aiFetch(URL)).resolves.toBeNull();
  });
});
