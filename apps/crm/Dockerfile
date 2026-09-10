# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/crm/package.json ./apps/crm/
COPY packages ./packages
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app ./
COPY apps/crm ./apps/crm
COPY packages ./packages
RUN pnpm --filter @skout/crm... build
RUN pnpm --filter @skout/crm deploy --prod /prod

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV MIGRATIONS_FOLDER=/app/db/drizzle
RUN addgroup -S skout && adduser -S skout -G skout
COPY --from=build /prod /app
COPY --from=build /app/packages/db/dist /app/db/dist
COPY --from=build /app/packages/db/drizzle /app/db/drizzle
COPY apps/crm/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
USER skout
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3002/api/v1/crm/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
