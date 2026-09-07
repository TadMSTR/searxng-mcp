# playwright-service with @ghostery/adblocker-playwright layered on top of the
# upstream ghcr.io/firecrawl/playwright-service image — the renderer Firecrawl
# v2 uses, and the one searxng-mcp actually runs (FIRECRAWL_API_VERSION=v2).
#
# This replaces AD_SERVING_DOMAINS — upstream's hardcoded substring list — with
# EasyList + EasyPrivacy. It is an UPGRADE of existing token adblocking, not a
# new capability.
#
# Layered, not forked: init-adblock.js is loaded via NODE_OPTIONS=--require and
# patches `require("playwright")` before api.ts runs. Not forking upstream is
# what kept the puppeteer version maintainable across releases; preserve it.
#
# ⚠ init-adblock.js sits in front of Firecrawl's in-browser SSRF guard. Read
#   its header before changing the route handler.
#
# Base image pinned by digest (security check DC-01). This is the digest the
# forge deployment runs, verified 2026-09-06. To bump:
#   docker pull ghcr.io/firecrawl/playwright-service:<NEW_TAG>
#   docker inspect ... --format '{{index .RepoDigests 0}}'
# and re-check api.ts's route ordering — the guard this hook chains into is
# upstream code and can move.
FROM ghcr.io/firecrawl/playwright-service@sha256:5cd4c2590eebcb8e0932553187d36ab7e76249165712b2bdbae6438b0b033d40

WORKDIR /usr/src/app

# Dependencies go in their OWN prefix, not the app's.
#
# Two constraints found by building it, neither obvious from the outside:
#   - The base image's node_modules are linked from /pnpm/store/v11, which is
#     root-owned, and the image runs as uid 1000. `pnpm add` fails with
#     ERR_PNPM_UNEXPECTED_STORE, and pointing it at that store fails again with
#     "attempt to write a readonly database".
#   - Running `npm install` inside /usr/src/app would let npm reconcile a tree
#     that pnpm built out of symlinks, which is a good way to quietly break the
#     service's own dependencies.
#
# So: install in a writable SUBDIRECTORY of the app (/usr/src is root-owned,
# so a sibling directory cannot be created as uid 1000) and let Node resolve and let Node's normal resolution find them —
# init-adblock.js lives in the same directory as its node_modules, so
# `require("@ghostery/adblocker-playwright")` resolves without NODE_PATH.
# `npm ci` from a COMMITTED lockfile, not `npm install <range>`.
#
# The previous version resolved `@ghostery/adblocker-playwright@^2` fresh on
# every build, so two builds of the same commit could produce different
# dependency trees — which quietly weakens the build-provenance attestation
# this image publishes, and leaves the deps invisible to any audit. The root
# `pnpm audit --prod` does not see this directory: it is not in the workspace
# (audit LOW, 2026-09-06).
# --chown is not optional: COPY creates the destination directory as root, and
# this image runs as uid 1000, so npm ci then fails EACCES trying to mkdir
# node_modules inside it. Same ownership trap as the COPY'd file under /tmp
# further down.
COPY --chown=node:node package.json package-lock.json /usr/src/app/adblock/
RUN cd /usr/src/app/adblock && npm ci --omit=dev --no-audit --no-fund

# The filter lists are VENDORED, not downloaded. Nothing in this build touches
# the network.
#
# Baking them in was already the right call — a startup that fetches them over
# TLS can crash the service outright: undici threw an internal assertion
# mid-fetch and killed the process, asynchronously and past any .catch(). Same
# reasoning as vendoring FlashRank's model into the reranker in v3.25.0.
#
# What changed in v3.29.0 is WHEN they are fetched. This step used to be
# `RUN node /tmp/fetch-lists.mjs`, which downloaded EasyList + EasyPrivacy at
# image build time. Two builds of the same commit could therefore produce
# different images, and somebody else's uptime sat on the release path: the
# v3.28.0 release failed on exactly this step and needed a re-run (vikunja#716).
#
# The re-run is the part that matters. This image sits in front of Firecrawl's
# in-browser SSRF guard and verify-ssrf-guard.sh is a real security control. A
# build that fails for unrelated network reasons trains whoever is releasing to
# re-run until green — which is precisely how a genuine verify-ssrf-guard
# failure would get re-run past.
#
# `sha256sum -c` replaces fetch-lists.mjs's MIN_BYTES guard and is strictly
# stronger: it fails the build on a corrupted, truncated or substituted list,
# not only on an implausibly small one. The invariant is unchanged — never
# produce an image whose adblocker reports success while blocking nothing.
#
# SHA256SUMS deliberately carries no .txt extension. init-adblock.js parses
# every *.txt in this directory as filter rules, so a checksum file named
# SHA256SUMS.txt would be fed to PlaywrightBlocker.parse() as if it were a list.
#
# Refresh with `node docker/playwright-adblock/fetch-lists.mjs`, or let
# .github/workflows/adblock-lists-refresh.yml open the PR. Each list's own
# `! Commit:` header records the exact upstream revision it came from.
#
# --chown is not optional here either: COPY creates the destination as root and
# this image runs as uid 1000.
COPY --chown=node:node lists/ /usr/src/app/adblock/lists/
RUN cd /usr/src/app/adblock/lists && sha256sum -c SHA256SUMS

COPY init-adblock.js /usr/src/app/adblock/init-adblock.js

ENV NODE_OPTIONS="--require /usr/src/app/adblock/init-adblock.js"
# ADBLOCK_FILTERS_URL is deliberately NOT set here. It is the opt-in switch for
# fetching lists at runtime, and setting it as an image default would mean the
# baked lists were never used — the switch defeated by its own default. Set it
# at deploy time only if you want lists newer than the image.
#
# ADBLOCK_REFRESH_HOURS likewise only applies to the fetching path; there is
# nothing to refresh when the lists come from the image.

# Same command and port as upstream — only the adblock hook differs.
