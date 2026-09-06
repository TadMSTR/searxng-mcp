import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { ProxyAgent } from "undici";
import { ChallengeDetectedError, detectChallenge } from "../challenge.js";
import { ADBLOCK_PROXY_URL, FIRECRAWL_API_VERSION } from "../config.js";
import {
  classifyContentType,
  looksLikeHtml,
  renderStructured,
} from "../content-type.js";
import {
  type FetchTuning,
  readBoundedText,
  safeFetch,
  type TierResult,
  USER_AGENT,
} from "../fetch-utils.js";
import { firecrawlSupportsPdf } from "../firecrawl-api.js";
import { warnDependencyFailure } from "../transport-failure.js";

// Create a ProxyAgent once at module init when ADBLOCK_PROXY_URL is configured.
// Passed as `dispatcher` to undici-backed fetch calls (Node.js 18+ global fetch).
const proxyAgent = ADBLOCK_PROXY_URL ? new ProxyAgent(ADBLOCK_PROXY_URL) : null;

/**
 * Extra request headers for the fetch. Used by the solver replay to carry the
 * solved session's User-Agent and its host-scoped cookies; a supplied
 * User-Agent replaces the default, since a solved Cloudflare session is bound
 * to the browser identity that solved it.
 */
export interface RawFetchHeaders {
  [name: string]: string;
}

export async function rawFetch(
  url: string,
  maxChars = 8000,
  tuning?: FetchTuning,
  extraHeaders?: RawFetchHeaders,
): Promise<TierResult> {
  // SSRF guard: safeFetch applies the string-level check (protecting future
  // direct callers, SSRF-08) and, absent the adblock proxy, routes through the
  // DNS-validating dispatcher so a public host resolving to a private address
  // is rejected at connect time. redirect: "manual" means we never follow a
  // redirect to an internal target — 3xx is thrown below.
  const fetchOptions: Parameters<typeof fetch>[1] & {
    dispatcher?: ProxyAgent;
  } = {
    headers: { "User-Agent": USER_AGENT, ...extraHeaders },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  };
  if (proxyAgent) fetchOptions.dispatcher = proxyAgent;

  const res = await safeFetch(url, fetchOptions);

  if (res.status >= 300 && res.status < 400) {
    // Don't echo the Location header into the thrown message — a redirect
    // to an internal address would surface that address to the MCP caller
    // (OE-02).
    throw new Error(`Redirect not followed (${res.status})`);
  }
  // Status/header challenge (403 or 503 from a Cloudflare edge). Checked ahead
  // of the generic !res.ok throw so the attempt is recorded as
  // `challenge_detected` rather than "Raw fetch error: 403" — the solver gate
  // keys on that reason.
  const statusSignal = detectChallenge(res.status, res.headers, null);
  if (statusSignal) throw new ChallengeDetectedError(statusSignal);

  if (!res.ok)
    throw new Error(`Raw fetch error: ${res.status} ${res.statusText}`);

  const body = await readBoundedText(res);

  // The 200-with-interstitial case, and the reason this check exists: res.ok is
  // true, so without it Readability extracts "Just a moment..." as an article
  // and the cascade books a hit.
  const bodySignal = detectChallenge(res.status, res.headers, body);
  if (bodySignal) throw new ChallengeDetectedError(bodySignal);

  // Raw fetch cannot extract PDF text, so say so — but only for something that
  // really is a PDF. Two deliberate choices here:
  //
  // Keyed on the header AND the `%PDF-` signature, because a body declared
  // application/pdf that does not start with those bytes is usually an
  // interstitial or an error page served with the wrong Content-Type. Rejecting
  // on the header alone turned those into a hard "this is a PDF" failure when
  // Readability could have extracted them; they now fall through below.
  //
  // Placed after the challenge check, so a Cloudflare interstitial mislabelled
  // as a PDF is still booked as `challenge_detected` and can reach the solver.
  //
  // The message names the actual cause. It used to read "use Crawl4AI", which
  // was wrong twice over: Crawl4AI cannot parse PDFs either, and reaching here
  // at all means tier 1 already declined. Under v2 that is a real tier-1
  // failure worth investigating; under v1 the backend simply has no PDF support
  // and no amount of config will change it (vikunja#682).
  if (
    res.headers.get("content-type")?.includes("application/pdf") &&
    body.startsWith("%PDF-")
  ) {
    throw new Error(
      firecrawlSupportsPdf()
        ? "PDF content cannot be extracted by raw fetch — tier 1 (Firecrawl) handles PDFs but returned nothing for this URL"
        : `PDF content cannot be extracted by raw fetch — FIRECRAWL_API_VERSION is ${FIRECRAWL_API_VERSION}, which has no PDF support; v2 does`,
    );
  }

  // Structured payloads short-circuit before JSDOM. Readability over a JSON
  // document finds no article, falls through to returning the raw string, and
  // reports the URL as the title — so the caller got an unformatted blob and
  // paid for a DOM parse to get it. Applies however tier3 was reached, not just
  // via the content-type fast path in fetchPage.
  const declared = classifyContentType(res.headers.get("content-type"));
  // A text/plain header over an HTML body is a server misconfiguration, not a
  // routing instruction — parse it as the markup it is.
  const structured =
    declared === "text" && looksLikeHtml(body) ? null : declared;
  if (structured) {
    return {
      title: url,
      url,
      text: renderStructured(body, structured).slice(0, maxChars),
      // No html: post-extraction (JSON-LD, og:title) is meaningless here, and
      // handing a JSON body to JSDOM downstream would repeat the mistake.
    };
  }

  const html = body;
  const dom = new JSDOM(html, { url }); // runScripts not set — script execution disabled

  // Client-side target_selector: scope extraction to the matched subtree.
  // wait_for_selector is a no-op here (raw HTTP renders no JS). If the selector
  // matches nothing, fall through to full-page extraction rather than erroring.
  let doc = dom.window.document;
  let selectorFallback: string | null = null;
  if (tuning?.targetSelector) {
    const el = doc.querySelector(tuning.targetSelector);
    if (el) {
      selectorFallback = el.textContent;
      doc = new JSDOM(el.outerHTML, { url }).window.document;
    }
  }

  const reader = new Readability(doc);
  const article = reader.parse();

  const text = (article?.textContent ?? selectorFallback ?? html).slice(
    0,
    maxChars,
  );
  const title = article?.title ?? url;
  return { title, url, text, html };
}

export async function fetchRawHtmlForMetadata(
  url: string,
): Promise<string | null> {
  // Raw HTTP fetch (no JS rendering) used as the source for JSON-LD and meta
  // tags. Tier 1/2 puppeteer renders inject payment-widget og:title tags and
  // can strip JSON-LD scripts; the unrendered HTML is more reliable for
  // post-extraction. Bounded by RAW_HTML_MAX_BYTES so large pages can't
  // amplify into a JSDOM-memory hazard (IV-14).
  // SSRF guard via safeFetch (string check + DNS-validating dispatcher);
  // exported, so protect against future direct callers with an internal URL
  // (SSRF-08 parity with rawFetch).
  try {
    const res = await safeFetch(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await readBoundedText(res);
  } catch (err) {
    // This is a side-channel enrichment fetch running in parallel with the
    // tier cascade, and a probe must not turn a fetchable URL into a hard
    // failure — so null stays the return value. What was wrong was doing it
    // silently: a metadata fetch failing for every URL (a DNS or egress
    // problem) looked exactly like every page happening to lack JSON-LD, and
    // `capabilities.metadata_fetch` was populated on 0 of 572 live records
    // with no indication of why (vikunja#687's class).
    warnDependencyFailure(err, "raw metadata fetch");
    return null;
  }
}
