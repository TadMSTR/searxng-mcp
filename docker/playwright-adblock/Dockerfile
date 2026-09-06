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
RUN mkdir -p /usr/src/app/adblock \
 && cd /usr/src/app/adblock \
 && npm init -y > /dev/null \
 && npm install --no-audit --no-fund \
      @ghostery/adblocker-playwright@^2 cross-fetch@^4

# Bake the filter lists into the image. A startup that fetches them over TLS
# can crash the service outright: undici threw an internal assertion mid-fetch
# and killed the process, asynchronously and past any .catch(). Same reasoning
# as vendoring FlashRank's model into the reranker in v3.25.0.
#
# fetch-lists.mjs fails the BUILD on a bad download rather than producing an
# image whose adblocker silently blocks nothing.
COPY fetch-lists.mjs /tmp/fetch-lists.mjs
# No `&& rm` here: COPY lands the file as root, /tmp is sticky, and the image
# runs as uid 1000 — the delete fails and takes the build with it.
RUN node /tmp/fetch-lists.mjs

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
