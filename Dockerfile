# syntax=docker/dockerfile:1

# node:22-alpine, pinned by multi-arch index digest. alpine is safe here because
# nothing in the dependency tree is native — jsdom and undici are pure JS — so
# there is no build toolchain in either stage. If a future dependency needs one,
# move to node:22-slim rather than adding build-essential to the runtime image.
ARG NODE_IMAGE=node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

FROM ${NODE_IMAGE} AS base
# pnpm, not npm: package-lock.json is gitignored and only pnpm-lock.yaml is the
# audited tree CI tests against. A stray `npm ci` here would resolve a different
# one.
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /app

# Full tree (dev deps included) — tsc lives here.
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Runtime dependencies only, resolved from the same lockfile.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# A container is only useful in HTTP mode, and it has to bind the wildcard
# address to be reachable by container name. That combination is exactly what
# SEARXNG_MCP_AUTH_TOKEN exists for — leave it unset and the server logs a loud
# warning at startup. See README "HTTP transport authentication".
ENV NODE_ENV=production \
    SEARXNG_MCP_TRANSPORT=http \
    SEARXNG_MCP_HOST=0.0.0.0 \
    SEARXNG_MCP_PORT=3001

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
# Read at runtime by src/version.ts.
COPY package.json ./

# uid/gid 1000, provided by the base image.
USER node

EXPOSE 3001

# busybox wget; /health is unauthenticated by design, so this needs no token.
# Note /health returns 503 when the cache backend is unreachable, so this marks
# the container unhealthy on a Valkey outage even though the server itself stays
# up and fails soft (cache miss -> serve live). That is deliberate: a silently
# cache-less server is worth surfacing. `restart: unless-stopped` does not act on
# health, so nothing restarts as a result.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${SEARXNG_MCP_PORT}/health" || exit 1

CMD ["node", "build/src/index.js"]
