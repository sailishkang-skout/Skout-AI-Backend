# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared
RUN pnpm --filter @skout/shared build
RUN pnpm --filter @skout/api build
# Flatten prod dependencies for the runtime image (pnpm symlinks break in plain COPY).
RUN pnpm --filter @skout/api deploy --prod /prod

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S skout && adduser -S skout -G skout
COPY --from=build /prod /app
USER skout
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/v1/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
