// Layer @ghostery/adblocker-playwright onto the upstream
// ghcr.io/firecrawl/playwright-service image without forking its api.ts.
// Loaded via NODE_OPTIONS="--require /usr/src/app/init-adblock.js" so it runs
// before api.ts requires `playwright`.
//
// ─── READ THIS BEFORE CHANGING THE HANDLER ──────────────────────────────────
//
// The upstream api.ts registers a context-level route that runs Firecrawl's
// in-browser SSRF guard:
//
//   await newContext.route('**/*', async (route, request) => {
//     try { await assertSafeTargetUrl(request.url()); }      // api.ts:245
//     catch (e) { ... return route.abort('blockedbyclient'); }
//     if (AD_SERVING_DOMAINS.some(...)) return route.abort();
//     return route.continue();                               // api.ts:263
//   });
//
// In Playwright, handlers run in REVERSE order of registration, and
// `route.continue()` dispatches the request immediately — "other matching
// handlers won't be invoked". Only `route.fallback()` passes control to the
// next handler. (Quoted from Playwright's own API reference.)
//
// So a handler registered after that one runs BEFORE it, and if it calls
// continue() the SSRF guard NEVER EXECUTES. Ads would still be blocked, pages
// would still render, and every functional test would pass — with Firecrawl's
// SSRF protection silently removed.
//
// This is not hypothetical. @ghostery/adblocker-playwright's own
// `enableBlockingInPage()` does exactly that: it registers `page.route('**/*')`
// (page routes take precedence over context routes) and calls `route.continue()`
// for every non-blocked request. Verified by reading 2.18.2's compiled source.
// That is why this file does NOT use enableBlockingInPage, and instead reuses
// the library's matching via its exported `fromPlaywrightDetails` + `match()`
// while keeping control of the disposition.
//
// THE RULE: every path out of this handler ends in abort() or fallback().
// NEVER continue(). A `continue()` here is a security regression that no
// "are ads blocked?" test can detect.
//
// Env vars (all optional):
//   ADBLOCK_DISABLE        — when "true", this module no-ops entirely.
//   ADBLOCK_FILTERS_URL    — comma-separated filter list URLs.
//                            Defaults to EasyList + EasyPrivacy.
//   ADBLOCK_REFRESH_HOURS  — rebuild interval, default 168 (7 days).

"use strict";

const Module = require("node:module");

// Re-entry guard. NOTE: this is deliberately a per-PROCESS global and NOT an
// environment variable.
//
// The upstream image's command is `pnpm start`, which SPAWNS `node dist/api.js`
// as a child. NODE_OPTIONS applies to both, so an env-var guard is set by the
// pnpm process — where the hook is useless — and then INHERITED by the child,
// which therefore skips installing. The server runs with no adblocking at all,
// while the log cheerfully reports "loaded 2 list(s)" from the parent.
//
// Observed exactly that with an env-var guard: the container starts, filter
// lists load, pages render, and nothing is blocked. A "does it start?" test
// passes; so does "are the lists loaded?".
const INSTALLED = Symbol.for("searxng-mcp.adblock.installed");

if (process.env.ADBLOCK_DISABLE === "true") {
  console.log("[adblock] disabled via ADBLOCK_DISABLE=true");
  module.exports = {};
} else {
  install();
}


function install() {
  if (globalThis[INSTALLED]) {
    console.warn("[adblock] already installed in this process — skipping");
    return;
  }
  globalThis[INSTALLED] = true;

  const FILTER_URLS = (
    process.env.ADBLOCK_FILTERS_URL ||
    "https://easylist.to/easylist/easylist.txt,https://easylist.to/easylist/easyprivacy.txt"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const REFRESH_MS =
    Math.max(1, Number(process.env.ADBLOCK_REFRESH_HOURS || "168")) *
    60 *
    60 *
    1000;

  let blocker = null;
  let blockerLoading = null;

  // Filter lists are BAKED INTO THE IMAGE at build time and parsed from disk.
  //
  // The first version fetched them over TLS at startup, and a flaky fetch to
  // easylist.to took the entire service down: undici threw
  // `AssertionError: assert(!this.paused)` from inside its own parser, which
  // is asynchronous and therefore not catchable by the .catch() on this
  // promise. Reproduced once in about six runs. A published image that renders
  // untrusted pages must not have a startup path that can crash it because a
  // third-party CDN hiccuped.
  //
  // Same reasoning as vendoring FlashRank's model into the reranker in
  // v3.25.0: no cold start, no runtime dependency, deterministic.
  //
  // Setting ADBLOCK_FILTERS_URL opts back into fetching, for an operator who
  // wants lists newer than the image. That path keeps the refresh loop; the
  // baked path has nothing to refresh.
  const BAKED_LISTS_DIR = "/usr/src/app/adblock/lists";
  const USE_BAKED = !process.env.ADBLOCK_FILTERS_URL;

  async function buildBlocker() {
    const { PlaywrightBlocker } = require("@ghostery/adblocker-playwright");
    const t0 = Date.now();

    if (USE_BAKED) {
      const fs = require("node:fs");
      const path = require("node:path");
      const files = fs
        .readdirSync(BAKED_LISTS_DIR)
        .filter((f) => f.endsWith(".txt"))
        .sort();
      if (files.length === 0) {
        // Do not silently run with no filters: that is an adblocker reporting
        // success while blocking nothing.
        throw new Error(`no filter lists found in ${BAKED_LISTS_DIR}`);
      }
      const text = files
        .map((f) => fs.readFileSync(path.join(BAKED_LISTS_DIR, f), "utf8"))
        .join("\n");
      blocker = PlaywrightBlocker.parse(text);
      console.log(
        `[adblock] parsed ${files.length} baked list(s) [${files.join(", ")}] in ${Date.now() - t0}ms`,
      );
      return;
    }

    const fetchImpl =
      typeof fetch === "function" ? fetch : require("cross-fetch").default;
    console.log(`[adblock] fetching filter lists: ${FILTER_URLS.join(", ")}`);
    blocker = await PlaywrightBlocker.fromLists(fetchImpl, FILTER_URLS);
    console.log(
      `[adblock] fetched ${FILTER_URLS.length} list(s) in ${Date.now() - t0}ms`,
    );
  }

  function startRefreshLoop() {
    setInterval(() => {
      buildBlocker().catch((err) => {
        console.error("[adblock] refresh failed:", err.message || err);
      });
    }, REFRESH_MS).unref();
  }

  // Loading is LAZY — kicked off when something actually requires playwright,
  // not when this module loads.
  //
  // The image's command is `pnpm start`, so NODE_OPTIONS loads this file into
  // the pnpm process too. Doing real work there is at best wasted (pnpm never
  // renders a page) and at worst fatal: eagerly requiring the ghostery
  // package inside pnpm crashed it with an assertion out of its own bundle.
  // pnpm never requires playwright, so gating on that keeps this hook out of
  // its way without having to guess at process identity from argv.
  function ensureBlockerLoading() {
    if (blockerLoading) return blockerLoading;
    blockerLoading = buildBlocker()
      .then(() => {
        // Nothing to refresh when the lists come from the image.
        if (!USE_BAKED) startRefreshLoop();
      })
      .catch((err) => {
        console.error("[adblock] initial load failed:", err.message || err);
        // Keep running. Requests fall through to the upstream handler, which
        // still applies the SSRF guard and the AD_SERVING_DOMAINS list.
      });
    return blockerLoading;
  }

  // The route handler. See the header: abort() or fallback(), never continue().
  async function adblockRoute(route) {
    try {
      if (!blocker) {
        // Page created before the filter lists finished loading.
        await Promise.race([
          ensureBlockerLoading(),
          new Promise((r) => setTimeout(r, 5000)),
        ]).catch(() => {});
      }
      if (!blocker) return route.fallback();

      const { fromPlaywrightDetails } = require("@ghostery/adblocker-playwright");
      const details = route.request();
      const request = fromPlaywrightDetails(details);
      if (request.type === "other") request.guessTypeOfRequest();

      // Main-frame navigations are never blocked — matching the library's own
      // behaviour, and blocking one would break the service outright.
      const frame = details.frame();
      if (
        request.isMainFrame() ||
        (request.type === "document" &&
          frame !== null &&
          frame.parentFrame() === null)
      ) {
        return route.fallback();
      }

      const { match } = blocker.match(request);
      if (match === true) return route.abort("blockedbyclient");
      return route.fallback();
    } catch (err) {
      // A failure to decide is not a reason to dispatch the request without
      // the SSRF guard. fallback() hands it to the upstream handler, which is
      // the safe direction; continue() would be the unsafe one.
      console.error("[adblock] route handler error:", err.message || err);
      try {
        return route.fallback();
      } catch {
        /* route already handled */
      }
    }
  }

  const ADBLOCK_ROUTE = Symbol("adblock.contextRouted");

  // Register OUR route immediately after upstream registers its '**/*' guard,
  // so ours is the more-recent handler and therefore runs first — which is
  // exactly why ours must fallback() into theirs rather than continue().
  function patchContext(context) {
    if (!context || context[ADBLOCK_ROUTE]) return context;
    const origRoute = context.route.bind(context);
    context.route = async (pattern, handler, options) => {
      const result = await origRoute(pattern, handler, options);
      if (pattern === "**/*" && !context[ADBLOCK_ROUTE]) {
        context[ADBLOCK_ROUTE] = true;
        await origRoute("**/*", adblockRoute);
        console.log("[adblock] context route installed (fallback-chained)");
      }
      return result;
    };
    return context;
  }

  function patchBrowser(browser) {
    if (!browser || browser[ADBLOCK_ROUTE]) return browser;
    browser[ADBLOCK_ROUTE] = true;
    const origNewContext = browser.newContext?.bind(browser);
    if (origNewContext) {
      browser.newContext = async (...args) =>
        patchContext(await origNewContext(...args));
    }
    return browser;
  }

  const origRequire = Module.prototype.require;
  const PATCHED = Symbol("adblock.patched");

  Module.prototype.require = function patchedRequire(id) {
    const mod = origRequire.apply(this, arguments);
    if ((id === "playwright" || id === "playwright-core") && mod && !mod[PATCHED]) {
      mod[PATCHED] = true;
      // The playwright service is /usr/src/app, NOT /app like the puppeteer one.
      try {
        const pkg = require("/usr/src/app/package.json");
        console.log(
          `[adblock] playwright required — engaging on playwright-service ${pkg.version}`,
        );
      } catch {
        console.log("[adblock] playwright required — engaging");
      }
      ensureBlockerLoading();
      for (const engine of ["chromium", "firefox", "webkit"]) {
        const browserType = mod[engine];
        if (!browserType || typeof browserType.launch !== "function") continue;
        const origLaunch = browserType.launch.bind(browserType);
        browserType.launch = async (...args) =>
          patchBrowser(await origLaunch(...args));
      }
    }
    return mod;
  };
}
