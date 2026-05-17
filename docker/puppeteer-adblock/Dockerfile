# puppeteer-service with @ghostery/adblocker-puppeteer layered on top of the
# upstream trieve/puppeteer-service-ts image. The upstream already wires
# puppeteer-extra-plugin-adblocker (with no args, so minimal blocking); we
# layer EasyList + EasyPrivacy via a require-time hook so we don't have to
# fork the upstream's api.ts. See init-adblock.js for the patch.
#
# Base image pinned by digest (security check DC-01). To bump:
#   docker pull trieve/puppeteer-service-ts:<NEW_TAG>
#   docker inspect ... --format '{{index .RepoDigests 0}}'
FROM trieve/puppeteer-service-ts@sha256:f6888a525d1bbfe221b9183f9dd9215cba704778aaef67d69236658b7e6d7eb1

WORKDIR /usr/src/app

# pnpm is available in the base image; add the ghostery adblocker + a fetch
# polyfill (Node 22 already has global fetch, but cross-fetch keeps us
# resilient if the base ever ships an older Node).
RUN pnpm add @ghostery/adblocker-puppeteer@^2 cross-fetch@^4

# init-adblock.js is loaded via NODE_OPTIONS=--require before api.ts runs.
# It monkey-patches puppeteer.launch() to wrap every new page with the
# ghostery blocker.
COPY init-adblock.js /usr/src/app/init-adblock.js

ENV NODE_OPTIONS="--require /usr/src/app/init-adblock.js"
ENV ADBLOCK_FILTERS_URL="https://easylist.to/easylist/easylist.txt,https://easylist.to/easylist/easyprivacy.txt"
ENV ADBLOCK_REFRESH_HOURS="168"

# Same command + port as upstream — only the adblock hook differs.
