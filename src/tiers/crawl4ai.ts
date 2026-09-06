import { CRAWL4AI_API_TOKEN, CRAWL4AI_URL } from "../config.js";
import {
  preferReadability,
  runReadability,
} from "../extractors/readability.js";
import {
  type FetchTuning,
  readBoundedText,
  type TierResult,
} from "../fetch-utils.js";
import { describeTransportFailure } from "../transport-failure.js";

/**
 * The crawl4ai version this tier is written against.
 *
 * Not decoration: the async job API was renamed *and* reshaped between the
 * version this code was first written for and this one, and both changes failed
 * silently — a wrong route returns 404 and a wrong shape yields empty markdown,
 * and each was indistinguishable from "the page had no content". The route and
 * shape assertions in tests/tiers/crawl4ai-job-api.test.ts run against a
 * fixture captured from this version's live /openapi.json.
 *
 * Moved 0.8.6 → 0.9.3 against a scratch 0.9.3 container, not against the
 * changelog. What that probe established, and what this tier now relies on:
 *
 *   - `/crawl/job/{task_id}` still exists; `/task/{task_id}` still does not.
 *     Both fixtures are kept and both are asserted, so "works on 0.9.3" cannot
 *     quietly become "no longer works on 0.8.6" — the deployed server is still
 *     0.8.6 when this ships.
 *   - The synchronous response is the *same* shape, `{results: [{markdown:
 *     {raw_markdown, fit_markdown, …}, metadata}]}`. 0.9.x was the untested
 *     third possibility; it turned out not to be one.
 *   - `proxy_config` is refused with HTTP 400 "field 'proxy_config' is not
 *     permitted on BrowserConfig from an untrusted request". `crawler_config`
 *     with css_selector and wait_for is accepted, so tuning still works.
 *   - 4xx keeps `{detail}`; only 5xx becomes `{error, correlation_id}`.
 */
export const CRAWL4AI_TARGET_VERSION = "0.9.3";

/**
 * An error this tier raised about the backend, as opposed to one thrown at it.
 *
 * The distinction exists so the outer transport handler can tell "the network
 * failed" from "we already described what went wrong" — without it a 401 came
 * out as `Crawl4AI: Crawl4AI error: 401 …`, wrapped by the handler meant for
 * raw fetch rejections.
 */
class Crawl4aiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Crawl4aiError";
  }
}

let warnedAboutMissingToken = false;

/**
 * Explain a tokenless auth failure, once, at the moment one actually happens.
 *
 * The plan asked for this to fire pre-emptively whenever the target version is
 * 0.9.x and no token is set. Built that way first, and it was wrong: this
 * client ships *before* the server upgrade, so for the whole window between
 * the two it would warn on every crawl against a healthy 0.8.6 that needs no
 * token and works perfectly. Verified against the deployed 0.8.6 — a false
 * alarm on a working system, which is how a warning gets trained away exactly
 * before the release where it matters.
 *
 * Firing on an observed failure instead is both quieter and stronger: it does
 * not depend on the target constant being accurate about the live server. It
 * covers the two shapes a tokenless 0.9.x actually presents, which are not the
 * same failure:
 *
 *   - HTTP 401, when the server did bind its published port.
 *   - A connection reset, when it did not. With no token, 0.9.x binds the
 *     *container's* loopback; `docker ps` reports healthy, the container's own
 *     /health returns 200, and the published port resets. Reproduced on a
 *     scratch 0.9.3: healthy at 45s uptime, curl exit 56 from the host.
 *
 * /health is unauthenticated even when a token IS set, so no healthcheck at
 * any layer distinguishes either case. This line is the only signal.
 */
function warnTokenlessAuthFailure(observed: string): void {
  if (warnedAboutMissingToken || CRAWL4AI_API_TOKEN) return;
  warnedAboutMissingToken = true;
  console.error(
    `[searxng-mcp] crawl4ai refused the request (${observed}) and CRAWL4AI_API_TOKEN is not set. ` +
      `crawl4ai ${CRAWL4AI_TARGET_VERSION} requires auth: with no token it binds the container's ` +
      "loopback, so the published port answers with a connection reset while the container still " +
      "reports healthy, and /health stays unauthenticated so no healthcheck will show it. " +
      "Set the same token on both crawl4ai and searxng-mcp.",
  );
}

/** Test seam: the warning fires once per process by design. */
export function resetCrawl4aiTokenWarning(): void {
  warnedAboutMissingToken = false;
}

/**
 * Upper bound on how much of crawl4ai's error prose is relayed into a tier
 * failure reason. Matches MAX_TIER_REASON_CHARS in fetch.ts; bounded here as
 * well so this function is safe on its own rather than relying on its caller.
 */
const MAX_UPSTREAM_DETAIL_CHARS = 200;

/**
 * Chromium surfaces transport failures as a stable `net::ERR_*` vocabulary,
 * and crawl4ai passes them through inside a long Python traceback. The token
 * is the whole diagnostic — `net::ERR_PROXY_CONNECTION_FAILED` is what
 * identified vikunja#690 — but it sits ~200 chars into the prose, i.e. exactly
 * where a head-truncated relay cuts it off. Lift it out and lead with it so
 * the signal survives any downstream bound.
 */
const NET_ERROR = /net::ERR_[A-Z_]+/;

/**
 * Turn a crawl4ai error response body into one bounded, single-line reason.
 *
 * Relaying upstream prose at all is a deliberate choice with a precedent: the
 * same decision was taken for Firecrawl's `data.error` and accepted at audit
 * (OE-02, 2026-09-06) on the grounds that this server is loopback-only and its
 * callers already hold the URL they asked for. The alternative — a canned
 * reason — is what made vikunja#690 invisible for weeks.
 */
// SECURITY[accepted]: relaying Crawl4AI's upstream `detail` / `error` /
// `correlation_id` is accepted rather than classified down to a canned reason.
// Filed as its OWN accepted-risks.md row rather than inheriting the Firecrawl
// one in src/fetch.ts: that row names "Firecrawl's upstream data.error" and is
// scoped to that relay, and per SC-23 a new relay source gets its own row. Same
// trust model — this server is loopback-only and its callers already hold the
// URL they asked for, so the text discloses nothing they do not have. The
// diagnostic value is the entire point: a canned reason is what let a 100% tier
// outage read as ordinary empty results for weeks (vikunja#690).
// Audit: 2026-09-06/searxng-mcp-crawl4ai-reranker-2026-09, finding OE-02 (Low).
// Decision: Ted, 2026-09-06.
// SECURITY[control]: bounded twice — 200 chars here at the source, and again by
// boundReason() at the fetch boundary; `correlation_id` is server-generated,
// opaque, and capped at 64. Crawl4AI no longer receives an internal proxy
// hostname to echo back, because this build removed the field that sent one.
export function crawl4aiErrorReason(label: string, body: string): string {
  let detail = "";
  let correlationId: string | undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    // Both server generations, verified against each: 0.8.6 and 0.9.x 4xx use
    // `{detail}`, and 0.9.x 5xx becomes `{error, correlation_id}` with the
    // message deliberately generic. `detail` is not always a string — a 422
    // validation failure makes it an array of objects, which read as a string
    // would silently drop the entire reason.
    if (typeof parsed.detail === "string") detail = parsed.detail;
    else if (parsed.detail !== undefined)
      detail = JSON.stringify(parsed.detail);
    else if (typeof parsed.error === "string") detail = parsed.error;

    // The generic 5xx text says nothing on its own — the correlation id is the
    // only way to find the real error in the server's logs, so it is the one
    // part that must not be dropped.
    if (typeof parsed.correlation_id === "string")
      correlationId = parsed.correlation_id;
  } catch {
    detail = body;
  }

  const flat = detail.replace(/\s+/g, " ").trim();
  const netErr = flat.match(NET_ERROR)?.[0];
  const head = flat.slice(0, MAX_UPSTREAM_DETAIL_CHARS);
  const prose = flat.length > MAX_UPSTREAM_DETAIL_CHARS ? `${head}…` : head;
  const corr = correlationId
    ? `[correlation_id=${correlationId.slice(0, 64)}]`
    : undefined;

  // corr goes before the prose for the same reason netErr does: it has to
  // survive a downstream truncation, and it is the actionable half.
  return [label, netErr, corr, prose].filter(Boolean).join(" ");
}

/**
 * Pull a TierResult out of one crawl4ai result object — the element of the
 * `results` array, which is the same shape whether it arrived synchronously
 * from /crawl or inside a completed job's envelope.
 */
function resultToTier(
  result: Record<string, unknown> | null | undefined,
  url: string,
  maxChars: number,
  preferFit: boolean,
): TierResult | null {
  const md = result?.markdown as Record<string, string> | null;
  const mdRaw = preferFit
    ? md?.fit_markdown || md?.raw_markdown
    : md?.raw_markdown || md?.fit_markdown;
  const text = (mdRaw ?? "").slice(0, maxChars);
  if (!text) return null;
  const metadata = result?.metadata as Record<string, string> | null;
  const title = metadata?.title || url;
  const html =
    typeof result?.html === "string" ? (result.html as string) : undefined;
  return { title, url, text, html };
}

/**
 * Poll an enqueued crawl job to completion.
 *
 * Two independent defects lived here, both silent (vikunja#684):
 *
 * The route was `/task/{id}`, which does not exist on 0.8.6 — it 404s, the
 * `!resp.ok` guard returned null, and the tier recorded an ordinary miss. That
 * spelling is still printed in upstream's own installation doc, which is
 * probably why two forge repos wrote it independently; the deployed
 * /openapi.json is the only authority.
 *
 * The response shape was also wrong, and repointing the route alone would not
 * have surfaced it. A completed job answers
 * `{status, task_id, url, created_at, _links, result: {results: [...], success}}`
 * — the crawl result is one level deeper than the old code's `data.result`.
 * Reading the old path yields undefined markdown, empty text, and another
 * silent miss. Older backends returned the flat shape, so both are accepted.
 */
export async function pollCrawl4aiTask(
  taskId: string,
  url: string,
  maxChars: number,
  signal: AbortSignal,
  preferFit = false,
): Promise<TierResult | null> {
  const deadline = Date.now() + 40_000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    // The only signal reaching here is crawl4aiFetch's own 45s controller, so
    // an abort is this client giving up rather than a caller cancelling.
    if (signal.aborted)
      throw new Crawl4aiError("Crawl4AI timeout while polling job");

    try {
      const resp = await fetch(`${CRAWL4AI_URL}/crawl/job/${taskId}`, {
        signal,
      });
      if (!resp.ok) {
        // A 404 here is the signature of exactly the bug this replaces: the
        // route moved and every crawl became an unexplained miss. Say so, so
        // the next rename is a visible failure rather than a silent tier drop.
        if (resp.status === 404) {
          console.error(
            `[searxng-mcp] crawl4ai job poll got 404 for /crawl/job/${taskId} — ` +
              `route or task expiry changed? this tier targets crawl4ai ${CRAWL4AI_TARGET_VERSION}`,
          );
        }
        throw new Crawl4aiError(
          crawl4aiErrorReason(
            `Crawl4AI error: ${resp.status}`,
            await readBoundedText(resp),
          ),
        );
      }

      const data = JSON.parse(await readBoundedText(resp)) as Record<
        string,
        unknown
      >;
      if (data.status === "completed") {
        const envelope = data.result as Record<string, unknown> | null;
        // 0.8.6: result.results[0]. Older backends put the crawl result
        // directly in `result`.
        const nested = Array.isArray(envelope?.results)
          ? (envelope.results[0] as Record<string, unknown> | undefined)
          : undefined;
        return resultToTier(nested ?? envelope, url, maxChars, preferFit);
      }
      // A failed job is the backend reporting it could not crawl the page —
      // the proxy failure in #690 arrives this way on backends that answer
      // asynchronously. Surface its own error text rather than booking a miss.
      if (data.status === "failed") {
        const detail =
          typeof data.error === "string"
            ? data.error
            : JSON.stringify(data.result ?? {});
        throw new Crawl4aiError(
          crawl4aiErrorReason(
            "Crawl4AI job failed:",
            JSON.stringify({ detail }),
          ),
        );
      }
    } catch (err) {
      if (err instanceof Crawl4aiError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new Crawl4aiError("Crawl4AI timeout while polling job");
      }
      throw err;
    }
  }

  // Falling out of the loop means the job never reached a terminal state
  // inside the poll budget. That is a backend that is too slow or stuck, not
  // a page with no content.
  throw new Crawl4aiError("Crawl4AI job poll deadline exceeded (40s)");
}

export async function crawl4aiFetch(
  url: string,
  maxChars = 8000,
  preferFit = false,
  tuning?: FetchTuning,
): Promise<TierResult | null> {
  if (!CRAWL4AI_URL) return null;

  // Well inside 0.9.x's 300s per-crawl wall clock, so the server's cap is
  // never what ends a request here — this client always gives up first. The
  // poll deadline below is 40s, so a crawl slower than that is abandoned
  // client-side; that is unchanged from 0.8.6 and is deliberate.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const crawlHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (CRAWL4AI_API_TOKEN)
      crawlHeaders.Authorization = `Bearer ${CRAWL4AI_API_TOKEN}`;
    // crawler_config is only attached when a selector is requested, so default
    // crawls send the exact same body as before. Crawl4AI honors css_selector
    // (scope extraction) and wait_for (CSS selector) natively.
    const crawlerConfig: Record<string, string> = {};
    if (tuning?.targetSelector)
      crawlerConfig.css_selector = tuning.targetSelector;
    if (tuning?.waitForSelector) {
      crawlerConfig.wait_for = `css:${tuning.waitForSelector}`;
    }
    const resp = await fetch(`${CRAWL4AI_URL}/crawl`, {
      method: "POST",
      headers: crawlHeaders,
      // DO NOT re-add `proxy_config` (or `proxy`) here, under any crawl4ai
      // version. It looks like it belongs — tier 3 does route through
      // ADBLOCK_PROXY_URL and it works there — but the two are not the same
      // thing. Tier 3 resolves the proxy hostname *in this process*; a
      // proxy_config in this body is resolved by *crawl4ai*, in its own
      // container, and the containers are on disjoint networks:
      //
      //   searxng-mcp    forge-net, searxng_fetch-net
      //   crawl4ai       forge-net, jobsearch-deps
      //   adblock-proxy  searxng_fetch-net ONLY
      //
      // So crawl4ai cannot resolve `adblock-proxy`, and every tier-2 crawl
      // returned net::ERR_PROXY_CONNECTION_FAILED — 100% failure, booked as an
      // ordinary empty result, for as long as ADBLOCK_PROXY_URL had been set
      // (vikunja#690). Probed live 2026-09-06 against 0.8.6 with a control:
      // the identical request without this field succeeded.
      //
      // Removing it is also a hard prerequisite for crawl4ai 0.9.x, which
      // rejects both spellings at the network trust boundary with HTTP 400.
      // Adblock filtering for tier 2 would have to be configured server-side
      // on crawl4ai and needs a network change that is not this process's to
      // make. Asserted by tests/tiers/crawl4ai-no-proxy.test.ts, which is the
      // only test file that sets ADBLOCK_PROXY_URL.
      body: JSON.stringify({
        urls: [url],
        ...(Object.keys(crawlerConfig).length > 0
          ? { crawler_config: crawlerConfig }
          : {}),
      }),
      signal: controller.signal,
    });

    // A non-2xx here is the backend refusing the crawl, not the page being
    // empty. Returning null booked it as `empty_result` — "attempted, no
    // content" — which is how a 100% tier outage read as ordinary misses for
    // weeks (vikunja#690, the concrete instance of #687). Tier 1 has always
    // thrown on this and runTier already records a thrown reason as an
    // `error` outcome; tier 2 was the outlier.
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        warnTokenlessAuthFailure(`HTTP ${resp.status}`);
      }
      throw new Crawl4aiError(
        crawl4aiErrorReason(
          `Crawl4AI error: ${resp.status}`,
          await readBoundedText(resp),
        ),
      );
    }
    // Bounded read (2 MB cap) before JSON.parse — consistency with the rest of
    // the fetch layer; caps memory even on an unexpected oversized response.
    const data = JSON.parse(await readBoundedText(resp)) as Record<
      string,
      unknown
    >;

    // Synchronous response — results returned directly. This is the path that
    // actually runs on 0.8.6: POST /crawl is synchronous there and never
    // returns a task_id. The async branch below is a compatibility path for
    // backends that answer 202 with one.
    if (Array.isArray(data.results) && data.results.length > 0) {
      return resultToTier(
        data.results[0] as Record<string, unknown>,
        url,
        maxChars,
        preferFit,
      );
    }

    // Asynchronous response — poll for completion
    if (typeof data.task_id === "string") {
      // Path-traversal guard on a value that goes into a URL path. Unchanged
      // in what it refuses; it now says so instead of passing for a miss.
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(data.task_id)) {
        throw new Crawl4aiError("Crawl4AI returned a malformed task_id");
      }
      return await pollCrawl4aiTask(
        data.task_id,
        url,
        maxChars,
        controller.signal,
        preferFit,
      );
    }

    // An empty `results` array IS an answer: the backend ran the crawl and
    // found nothing. That is a real empty result and must stay `null`, or this
    // tier starts erroring on pages that are genuinely blank.
    //
    // Note the branch above tests `.length > 0`, so it does NOT cover this —
    // an early version of this guard threw here and converted every genuine
    // empty crawl into a tier error. The test named "still treats an empty
    // results array as a genuine empty answer" is what caught it.
    if (Array.isArray(data.results)) return null;

    // Neither `results` in any form nor a `task_id`: the backend is speaking a
    // protocol we do not recognise — a version skew, or something else
    // answering in its place (a proxy error page, an auth portal). Not an
    // empty page. `null` here would be booked by runTier as `empty_result`,
    // the exact conflation #690 existed to remove.
    throw new Crawl4aiError(
      "Crawl4AI returned 200 with neither results nor a task_id — unrecognised response shape",
    );
  } catch (err) {
    // Transport failures reach here: connection refused, connection reset, DNS
    // failure, TLS rejection — and our own 45s abort. None of them mean the
    // page was empty, and all of them were previously indistinguishable from
    // one. This matters beyond #690: a crawl4ai 0.9.x server started without
    // CRAWL4AI_API_TOKEN binds the container's loopback and answers published
    // ports with a connection reset *while reporting healthy*, so a silent
    // null here would be the only symptom of a dead tier.
    // Already described by this tier — re-wrapping produced the duplicated
    // "Crawl4AI: Crawl4AI error: 401 …" that the live 0.9.3 probe surfaced.
    if (err instanceof Crawl4aiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new Crawl4aiError("Crawl4AI timeout after 45s");
    }
    const described = describeTransportFailure(err, "Crawl4AI");
    // A connection reset with no token configured is the other face of the
    // same misconfiguration as a 401 — the server bound container-loopback.
    if (/ECONNRESET|ECONNREFUSED/.test(described)) {
      warnTokenlessAuthFailure(described);
    }
    throw new Crawl4aiError(described);
  } finally {
    clearTimeout(timeout);
  }
}

export function applyTier2Readability(
  fetched: TierResult,
  url: string,
): TierResult {
  if (!fetched.html) return fetched;
  const readable = runReadability(fetched.html, url);
  if (preferReadability(readable, fetched) && readable) {
    return {
      ...fetched,
      title: readable.title ?? fetched.title,
      text: readable.text,
    };
  }
  return fetched;
}
