# Skout CRM Service

Native Revenue Workspace API (companies, contacts, deals, activities) on the shared PostgreSQL data layer.

## Stack

- **Runtime:** Node 20 + TypeScript (Fastify 5)
- **Auth:** Clerk JWT (same as `@skout/api`) via `@skout/auth`
- **Database:** `@skout/db` (Drizzle + shared RDS)

## Local development

```bash
# From repo root (Postgres on :5434 via docker-compose)
pnpm --filter @skout/crm dev
```

Service listens on **http://localhost:3002**.

## Endpoints (scaffold)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/v1/crm/health` | Public |
| GET | `/api/v1/companies` | Required |
| GET | `/api/v1/contacts` | Required |
| GET | `/api/v1/deals` | Required |
| GET | `/api/v1/deals/summary` | Required |

Stub auth in dev: header `x-stub-user-email: you@example.com`.

## Tests

```bash
pnpm --filter @skout/crm test
pnpm --filter @skout/crm test:e2e
```

## Docker

```bash
docker build -f apps/crm/Dockerfile -t skout-crm:local .
```

Deployed to ECS as `crm` service with ALB paths `/api/v1/companies*`, `/api/v1/contacts*`, `/api/v1/deals*`, `/api/v1/crm/health`.
