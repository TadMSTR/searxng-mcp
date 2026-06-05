# adblock-proxy — HTTP forward proxy with @ghostery/adblocker for searxng-mcp tiers 2+3.
# Blocks plain-HTTP ad/tracker requests. HTTPS CONNECT is tunneled without MITM.
FROM node:20-alpine

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
