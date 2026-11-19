# adblock-proxy — HTTP forward proxy with @ghostery/adblocker for searxng-mcp tiers 2+3.
# Blocks plain-HTTP ad/tracker requests. HTTPS CONNECT is tunneled without MITM.
#
# Base image pinned by digest (security check DC-01). To update:
#   docker pull node:24-alpine
#   docker inspect node:24-alpine --format '{{index .RepoDigests 0}}'
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

RUN addgroup -S proxy && adduser -S proxy -G proxy

WORKDIR /app

# `npm ci` from a committed lockfile: reproducible, and the pinned set is
# visible to the CI audit step. `npm install` re-resolved the caret range on
# every build (audit LOW, 2026-09-06).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ssrf.js is required by proxy.js at startup — a COPY that lists only proxy.js
# produces an image that crash-loops on MODULE_NOT_FOUND.
COPY proxy.js ssrf.js ./

USER proxy

ENV PORT="8118"
ENV ADBLOCK_FILTERS_URL="https://easylist.to/easylist/easylist.txt,https://easylist.to/easylist/easyprivacy.txt"
ENV ADBLOCK_REFRESH_HOURS="168"
ENV LOG_BLOCKED="false"

EXPOSE 8118

# /health is 200 only while a rule set with network filters is loaded and is
# newer than two refresh intervals (proxy.js healthBody). A partial rule set
# (some lists missing) is still 200, with status "partial".
# Node, not curl: the image has no curl, and busybox wget's exit codes are not
# worth depending on. The start period covers the startup list fetch, which
# runs before the port opens (up to 30 s per list).
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "-e", "require('http').get({host:'127.0.0.1',port:process.env.PORT||8118,path:'/health',timeout:4000},(r)=>process.exit(r.statusCode===200?0:1)).on('timeout',function(){this.destroy()}).on('error',()=>process.exit(1))"]

CMD ["node", "proxy.js"]
