# syntax=docker/dockerfile:1
# Build: docker build -f workers/scrapers/Dockerfile \
#   --build-arg WORKER_PACKAGE=@skout/scraper-orchestrator \
#   --build-arg WORKER_SUBPATH=orchestrator -t scraper-orchestrator .

FROM --platform=linux/amd64 node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY workers/scrapers/orchestrator/package.json ./workers/scrapers/orchestrator/
COPY workers/scrapers/cleaner/package.json ./workers/scrapers/cleaner/
COPY workers/scrapers/ingestor/package.json ./workers/scrapers/ingestor/
RUN pnpm install --frozen-lockfile

FROM base AS build
ARG WORKER_PACKAGE=@skout/scraper-orchestrator
ARG WORKER_SUBPATH=orchestrator
COPY --from=deps /app ./
COPY workers/scrapers/${WORKER_SUBPATH} ./workers/scrapers/${WORKER_SUBPATH}
RUN pnpm --filter ${WORKER_PACKAGE}... build
RUN pnpm --filter ${WORKER_PACKAGE} deploy --prod /prod

FROM --platform=linux/amd64 node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S skout && adduser -S skout -G skout
COPY --from=build /prod /app
COPY workers/scrapers/healthcheck.mjs /app/healthcheck.mjs
USER skout
CMD ["node", "dist/worker.js"]
