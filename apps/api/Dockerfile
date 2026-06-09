# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
RUN pnpm --filter @skout/shared build
RUN pnpm --filter @skout/db build
RUN pnpm --filter @skout/api build
# Flatten prod dependencies for the runtime image (pnpm symlinks break in plain COPY).
RUN pnpm --filter @skout/api deploy --prod /prod

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV MIGRATIONS_FOLDER=/app/node_modules/@skout/db/drizzle
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
