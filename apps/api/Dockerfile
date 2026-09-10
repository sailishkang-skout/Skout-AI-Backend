# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages ./packages
COPY workers/scrapers/orchestrator/package.json ./workers/scrapers/orchestrator/
RUN pnpm install --frozen-lockfile

FROM base AS build
# Copy full install tree so workspace packages resolve tsc and devDependencies.
COPY --from=deps /app ./
COPY apps/api ./apps/api
COPY packages ./packages
COPY workers/scrapers/orchestrator ./workers/scrapers/orchestrator
RUN pnpm --filter @skout/api... build
# Flatten prod dependencies for the runtime image (pnpm symlinks break in plain COPY).
RUN pnpm --filter @skout/api deploy --prod /prod

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV MIGRATIONS_FOLDER=/app/db/drizzle
RUN addgroup -S skout && adduser -S skout -G skout
COPY --from=build /prod /app
COPY --from=build /app/packages/db/dist /app/db/dist
COPY --from=build /app/packages/db/drizzle /app/db/drizzle
COPY apps/api/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
USER skout
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/v1/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
