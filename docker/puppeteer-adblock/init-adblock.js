// Layer @ghostery/adblocker-puppeteer onto the upstream trieve/puppeteer-
// service-ts image without forking its api.ts. Loaded via
// NODE_OPTIONS="--require /usr/src/app/init-adblock.js" so it runs before
// api.ts requires `puppeteer`.
//
// Env vars (all optional):
//   ADBLOCK_DISABLE        — when "true", this module no-ops entirely.
//   ADBLOCK_FILTERS_URL    — comma-separated list of filter list URLs.
//                            Defaults to EasyList + EasyPrivacy.
//   ADBLOCK_REFRESH_HOURS  — interval at which the blocker rebuilds itself
//                            from the configured URLs. Default 168 (7 days).

"use strict";

const Module = require("node:module");

if (process.env.ADBLOCK_DISABLE === "true") {
  console.log("[adblock] disabled via ADBLOCK_DISABLE=true");
  module.exports = {};
} else {
  install();
}

function install() {
  if (process.env._ADBLOCK_LOADED) {
    console.warn("[adblock] _ADBLOCK_LOADED already set — skipping install (adblocking may be inactive)");
    return;
  }
  process.env._ADBLOCK_LOADED = "1";

  try {
    const pkg = require("/app/package.json");
    console.log(`[adblock] wrapping puppeteer-service ${pkg.version}`);
  } catch {
    console.log("[adblock] wrapping puppeteer-service (version unknown)");
  }

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

async function buildBlocker() {
  const { PuppeteerBlocker } = require("@ghostery/adblocker-puppeteer");
  // Node 22+ has a global fetch; cross-fetch is loaded as a fallback only.
  const fetchImpl =
    typeof fetch === "function" ? fetch : require("cross-fetch").default;
  console.log(`[adblock] loading filter lists: ${FILTER_URLS.join(", ")}`);
  const t0 = Date.now();
  const next = await PuppeteerBlocker.fromLists(fetchImpl, FILTER_URLS);
  console.log(
    `[adblock] loaded ${FILTER_URLS.length} list(s) in ${Date.now() - t0}ms`,
  );
  blocker = next;
}

function startRefreshLoop() {
  setInterval(() => {
    buildBlocker().catch((err) => {
      console.error("[adblock] refresh failed:", err.message || err);
    });
  }, REFRESH_MS).unref();
}

blockerLoading = buildBlocker()
  .then(startRefreshLoop)
  .catch((err) => {
    console.error("[adblock] initial load failed:", err.message || err);
    // Continue running — pages just won't get blocking applied.
  });

async function applyBlocker(page) {
  if (!blocker) {
    // Race: page created before initial load completed. Wait briefly.
    try {
      await Promise.race([
        blockerLoading,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      // ignore — fall through to no-op if still not ready
    }
  }
  if (!blocker) return;
  try {
    await blocker.enableBlockingInPage(page);
  } catch (err) {
    // Page may already be closed or the blocker may not support this page
    // shape (e.g. ServiceWorker contexts). Never throw from the hook.
    console.error(
      "[adblock] enableBlockingInPage failed:",
      err.message || err,
    );
  }
}

// Require hook: when api.ts (or any dependency) does `require('puppeteer')`,
// return a proxy that wraps launch() so every browser/page from this point
// on gets the blocker attached. puppeteer-extra wraps puppeteer.launch
// internally too — we patch the result of launch, not launch itself, so we
// compose with whatever extra plugins the upstream installs.
const origRequire = Module.prototype.require;
const PATCHED = Symbol("adblock.patched");

function patchBrowser(browser) {
  if (!browser || browser[PATCHED]) return browser;
  browser[PATCHED] = true;

  const origNewPage = browser.newPage?.bind(browser);
  if (origNewPage) {
    browser.newPage = async (...args) => {
      const page = await origNewPage(...args);
      await applyBlocker(page);
      return page;
    };
  }

  // puppeteer-cluster's CONCURRENCY_CONTEXT path goes through
  // browser.createBrowserContext() -> context.newPage(). Patch the context
  // factory so per-context pages get the blocker too.
  const origCreateContext =
    browser.createBrowserContext?.bind(browser) ||
    browser.createIncognitoBrowserContext?.bind(browser);
  if (origCreateContext) {
    const wrap = async (...args) => {
      const ctx = await origCreateContext(...args);
      if (ctx && !ctx[PATCHED]) {
        ctx[PATCHED] = true;
        const ctxNewPage = ctx.newPage.bind(ctx);
        ctx.newPage = async (...nargs) => {
          const page = await ctxNewPage(...nargs);
          await applyBlocker(page);
          return page;
        };
      }
      return ctx;
    };
    if (browser.createBrowserContext) browser.createBrowserContext = wrap;
    if (browser.createIncognitoBrowserContext)
      browser.createIncognitoBrowserContext = wrap;
  }

  return browser;
}

Module.prototype.require = function patchedRequire(id) {
  const mod = origRequire.apply(this, arguments);
  if ((id === "puppeteer" || id === "puppeteer-extra") && !mod[PATCHED]) {
    mod[PATCHED] = true;
    if (typeof mod.launch === "function") {
      const origLaunch = mod.launch.bind(mod);
      mod.launch = async (...args) => patchBrowser(await origLaunch(...args));
    }
  }
  return mod;
};

} // end install()

