// Solver tier: the FlareSolverr-v1 client, its miss conditions, and the SSRF
// guard on the replay.
//
// Acceptance for this tier is deliberately NOT a solve-success rate — Byparr's
// own README states a bypass is not guaranteed. What must hold is that the
// replay is guarded, solver-returned credentials never leave the solved host,
// and every failure mode is a clean miss.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  SOLVER_URL: "http://byparr:8191",
  SOLVER_ENABLED: true,
  SOLVER_MAX_TIMEOUT_MS: 60_000,
  ADBLOCK_PROXY_URL: null,
}));

// Public for the solved host, private for the redirect-to-internal case.
vi.mock("node:dns/promises", () => ({
  lookup: (hostname: string) =>
    hostname === "internal.example.com"
      ? Promise.resolve([{ address: "10.0.0.5", family: 4 }])
      : Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  buildScopedCookieHeader,
  solverFetch,
} from "../../src/tiers/solver.js";

const URL_UNDER_TEST = "https://protected.example.com/article";

const ARTICLE_HTML = `<html><head><title>Real Article</title></head><body>
<article><h1>Real Article</h1>
<p>This is the content that was sitting behind the challenge, with enough text
to pass Readability's scoring threshold comfortably.</p>
<p>A second paragraph so the extractor is confident about the article body.</p>
</article></body></html>`;

function solverResponse(solution: Record<string, unknown>) {
  return new Response(JSON.stringify({ solution }), { status: 200 });
}

function pageResponse(html: string) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "Content-Type": "text/html" }),
    // Real stream: solverFetch replays through readBoundedText, which reads
    // res.body. `body: null` would exercise the no-reader path instead.
    body: new Response(html).body as ReadableStream<Uint8Array>,
    text: () => Promise.resolve(html),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("solverFetch — happy path", () => {
  it("solves, replays through the bounded reader, and returns extracted text", async () => {
    mockFetch
      .mockResolvedValueOnce(
        solverResponse({
          url: URL_UNDER_TEST,
          status: 200,
          userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/141",
          cookies: [
            {
              name: "cf_clearance",
              value: "abc123",
              domain: ".protected.example.com",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(pageResponse(ARTICLE_HTML));

    const result = await solverFetch(URL_UNDER_TEST, 10000);

    expect(result?.title).toBe("Real Article");
    expect(result?.text).toContain("sitting behind the challenge");
  });

  it("sends the v1 contract body to the solver", async () => {
    mockFetch
      .mockResolvedValueOnce(
        solverResponse({ url: URL_UNDER_TEST, status: 200 }),
      )
      .mockResolvedValueOnce(pageResponse(ARTICLE_HTML));

    await solverFetch(URL_UNDER_TEST);

    const [endpoint, init] = mockFetch.mock.calls[0];
    expect(endpoint).toBe("http://byparr:8191/v1");
    expect(JSON.parse(init.body)).toEqual({
      cmd: "request.get",
      url: URL_UNDER_TEST,
      maxTimeout: 60_000,
    });
  });

  it("replays under the solved session's User-Agent and cookies", async () => {
    // A solved Cloudflare session is bound to the browser identity that solved
    // it; replaying under our own User-Agent re-triggers the challenge.
    mockFetch
      .mockResolvedValueOnce(
        solverResponse({
          url: URL_UNDER_TEST,
          status: 200,
          userAgent: "Mozilla/5.0 Chrome/141",
          cookies: [
            {
              name: "cf_clearance",
              value: "abc123",
              domain: ".protected.example.com",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(pageResponse(ARTICLE_HTML));

    await solverFetch(URL_UNDER_TEST);

    const replayHeaders = mockFetch.mock.calls[1][1].headers;
    expect(replayHeaders["User-Agent"]).toBe("Mozilla/5.0 Chrome/141");
    expect(replayHeaders.Cookie).toBe("cf_clearance=abc123");
  });

  it("does not return the solver's own HTML directly", async () => {
    // solution.response would bypass the size bound, the content-type routing
    // and the extraction path — so the replay is a real fetch, not a shortcut.
    mockFetch
      .mockResolvedValueOnce(
        solverResponse({
          url: URL_UNDER_TEST,
          status: 200,
          response: "<html><body>solver copy</body></html>",
        }),
      )
      .mockResolvedValueOnce(pageResponse(ARTICLE_HTML));

    const result = await solverFetch(URL_UNDER_TEST, 10000);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result?.text).not.toContain("solver copy");
  });
});

describe("solverFetch — miss conditions", () => {
  it("misses when the solver reports a non-2xx origin status", async () => {
    // Failing to solve is the common case, not an exception.
    mockFetch.mockResolvedValueOnce(
      solverResponse({ url: URL_UNDER_TEST, status: 403 }),
    );
    expect(await solverFetch(URL_UNDER_TEST)).toBeNull();
    expect(mockFetch).toHaveBeenCalledOnce(); // no replay attempted
  });

  it("misses when the response carries no solution", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "error" }), { status: 200 }),
    );
    expect(await solverFetch(URL_UNDER_TEST)).toBeNull();
  });

  it("misses on a non-OK response from the solver itself", async () => {
    mockFetch.mockResolvedValueOnce(new Response("nope", { status: 502 }));
    expect(await solverFetch(URL_UNDER_TEST)).toBeNull();
  });

  it("misses when the solver is unreachable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await solverFetch(URL_UNDER_TEST)).toBeNull();
  });

  it("misses on an unparseable solver body", async () => {
    mockFetch.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    expect(await solverFetch(URL_UNDER_TEST)).toBeNull();
  });

  it("propagates a challenge when the 'solved' page is still an interstitial", async () => {
    // The replay goes through rawFetch, which re-runs detection — so a solver
    // that reported success on a page that is still challenged is booked as a
    // challenge miss rather than cached as content.
    mockFetch
      .mockResolvedValueOnce(
        solverResponse({ url: URL_UNDER_TEST, status: 200 }),
      )
      .mockResolvedValueOnce(
        pageResponse(
          "<html><head><title>Just a moment...</title></head><body></body></html>",
        ),
      );

    await expect(solverFetch(URL_UNDER_TEST)).rejects.toThrow(
      "Challenge detected",
    );
  });
});

describe("solverFetch — SSRF guard on the replay", () => {
  it("rejects a replay to a private address the solver redirected to", async () => {
    // THE control for the replay guard. The new exposure this tier introduces:
    // the solver follows redirects on our behalf, so solution.url is a fresh
    // address no guard has seen. A public *hostname* that resolves to a private
    // address is the case only assertResolvedPublic catches — the string-level
    // check inside rawFetch cannot see it. Verified to go red when the guard is
    // removed. Mocked rather than waiting on a live case.
    mockFetch.mockResolvedValueOnce(
      solverResponse({
        url: "https://internal.example.com/admin",
        status: 200,
      }),
    );

    expect(await solverFetch(URL_UNDER_TEST)).toBeNull();
    expect(mockFetch).toHaveBeenCalledOnce(); // replay never dispatched
  });

  // The next two hold via the replay guard AND, independently, via rawFetch's
  // own assertPublicUrl — a literal private IP and a non-http scheme are both
  // visible to a string-level check. They stay green if the replay guard is
  // removed, so they record defence in depth rather than constraining the guard;
  // the DNS-rebinding test above is what does that.
  it("rejects a replay to a literal private address", async () => {
    mockFetch.mockResolvedValueOnce(
      solverResponse({
        url: "http://169.254.169.254/latest/meta-data/",
        status: 200,
      }),
    );

    expect(await solverFetch(URL_UNDER_TEST)).toBeNull();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("rejects a replay to a non-http scheme", async () => {
    mockFetch.mockResolvedValueOnce(
      solverResponse({ url: "file:///etc/passwd", status: 200 }),
    );

    expect(await solverFetch(URL_UNDER_TEST)).toBeNull();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("allows a validated cross-host redirect but does not carry the old host's cookies", async () => {
    mockFetch
      .mockResolvedValueOnce(
        solverResponse({
          url: "https://cdn.example.org/article",
          status: 200,
          cookies: [
            {
              name: "cf_clearance",
              value: "abc123",
              domain: ".protected.example.com",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(pageResponse(ARTICLE_HTML));

    const result = await solverFetch(URL_UNDER_TEST, 10000);

    expect(result).not.toBeNull();
    expect(mockFetch.mock.calls[1][0]).toBe("https://cdn.example.org/article");
    expect(mockFetch.mock.calls[1][1].headers.Cookie).toBeUndefined();
  });
});

describe("buildScopedCookieHeader", () => {
  it("keeps cookies whose domain covers the host", () => {
    expect(
      buildScopedCookieHeader(
        [
          { name: "a", value: "1", domain: ".example.com" },
          { name: "b", value: "2", domain: "www.example.com" },
        ],
        "www.example.com",
      ),
    ).toBe("a=1; b=2");
  });

  it("drops cookies scoped to a different host", () => {
    // A solver-returned cookie is never forwarded to another origin.
    expect(
      buildScopedCookieHeader(
        [{ name: "a", value: "1", domain: "evil.example.net" }],
        "www.example.com",
      ),
    ).toBeNull();
  });

  it("treats a domainless cookie as belonging to the host", () => {
    expect(
      buildScopedCookieHeader([{ name: "a", value: "1" }], "www.example.com"),
    ).toBe("a=1");
  });

  it("refuses a value carrying CR/LF (header injection)", () => {
    // These values are attacker-influenced and are concatenated into a request
    // header that does no escaping of its own, so the only safe move is to
    // drop them.
    expect(
      buildScopedCookieHeader(
        [{ name: "a", value: "1\r\nX-Injected: yes", domain: "example.com" }],
        "example.com",
      ),
    ).toBeNull();
  });

  it("refuses a value carrying a semicolon (cookie-pair forgery)", () => {
    expect(
      buildScopedCookieHeader(
        [{ name: "a", value: "1; admin=true", domain: "example.com" }],
        "example.com",
      ),
    ).toBeNull();
  });

  it("keeps the safe cookies alongside a refused one", () => {
    expect(
      buildScopedCookieHeader(
        [
          { name: "ok", value: "fine", domain: "example.com" },
          { name: "bad", value: "a\nb", domain: "example.com" },
        ],
        "example.com",
      ),
    ).toBe("ok=fine");
  });

  it("ignores malformed entries", () => {
    expect(
      buildScopedCookieHeader(
        [null, "nope", { name: 1, value: 2 }, { name: "a" }],
        "example.com",
      ),
    ).toBeNull();
    expect(buildScopedCookieHeader(undefined, "example.com")).toBeNull();
    expect(buildScopedCookieHeader("not-an-array", "example.com")).toBeNull();
  });

  it("does not treat a suffix collision as a domain match", () => {
    // notexample.com must not match a cookie scoped to example.com.
    expect(
      buildScopedCookieHeader(
        [{ name: "a", value: "1", domain: "example.com" }],
        "notexample.com",
      ),
    ).toBeNull();
  });
});
