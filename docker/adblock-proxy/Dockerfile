# adblock-proxy — HTTP forward proxy with @ghostery/adblocker for searxng-mcp tiers 2+3.
# Blocks plain-HTTP ad/tracker requests. HTTPS CONNECT is tunneled without MITM.
#
# Base image pinned by digest (security check DC-01). To update:
#   docker pull node:20-alpine
#   docker inspect node:20-alpine --format '{{index .RepoDigests 0}}'
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

RUN addgroup -S proxy && adduser -S proxy -G proxy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY proxy.js ./

USER proxy

ENV PORT="8118"
ENV ADBLOCK_FILTERS_URL="https://easylist.to/easylist/easylist.txt,https://easylist.to/easylist/easyprivacy.txt"
ENV ADBLOCK_REFRESH_HOURS="168"
ENV LOG_BLOCKED="false"

EXPOSE 8118

CMD ["node", "proxy.js"]
