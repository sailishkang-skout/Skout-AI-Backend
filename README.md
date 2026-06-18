# Skout AI — Backend

Monorepo for the Skout AI platform backend, aligned with the production blueprint and system components catalog.

## Tech stack

### Application

| Layer | Technology |
| --- | --- |
| **Core API** | Node.js 20+, TypeScript, **Fastify 5**, Zod validation |
| **AI service** | Python, **FastAPI**, LiteLLM |
| **Frontend** (separate repo) | Next.js 14, React 18, Tailwind, TanStack Query, Clerk |
| **Shared contracts** | `@skout/shared` — Zod schemas, identity helpers |
| **Database** | PostgreSQL, **Drizzle ORM** (`@skout/db`) |
| **Search** | OpenSearch (`@skout/opensearch`) |
| **Enrichment** | **PAL** (`@skout/pal`) — provider abstraction + BYOK |
| **Observability** | `@skout/observability` — Pino structured logging, Sentry, redaction |
| **Cache / queues** | Redis, BullMQ (MVP) → Temporal + Kafka (v1) |
| **Analytics DB** | ClickHouse (wire in staging) |

### Integrations

| Area | Technology |
| --- | --- |
| **Auth** | Clerk (JWT), workspace provisioning |
| **CRM** | HubSpot OAuth (import/export) |
| **BYOK** | Workspace integration keys (AES-256-GCM) |
| **Enrichment providers** | Hunter, MillionVerifier, ZeroBounce, PDL, Explorium, etc. |

### Infrastructure (AWS)

| Layer | Technology |
| --- | --- |
| **IaC** | AWS CDK v2 (TypeScript) |
| **Compute** | ECS Fargate (api, ai, web) |
| **Load balancing** | ALB + API Gateway (HTTPS) |
| **Data** | RDS PostgreSQL, ElastiCache Redis, S3 |
| **Registry** | ECR, GitHub OIDC deploy role |
| **Secrets** | AWS Secrets Manager |
| **Logging** | **CloudWatch Logs** (`/skout/{env}/api`, `web`, `ai`) |
| **Monitoring** | CloudWatch alarms (ALB 5xx, CPU, API error logs), SNS |
| **Error tracking** | Sentry (optional, via `SENTRY_DSN`) |
| **Phase 2 APM** | Datadog (optional, via `DD_API_KEY`) |

> **Not used (Kubernetes stack):** Helm, Prometheus, Grafana self-hosted — Skout runs on **ECS**, not EKS. Use CloudWatch + Sentry now; add Datadog later if you want unified APM dashboards.

### CI/CD

| Tool | Purpose |
| --- | --- |
| GitHub Actions | `ci.yml`, `deploy-dev.yml`, `deploy-prod.yml` |
| Husky | Pre-commit tests |
| Docker | API / AI / Web images → ECR |

## Structure

```
Skout AI Backend/
├── apps/
│   ├── api/              # Core REST API (Fastify) — port 3001
│   └── ai/               # AI orchestration (FastAPI) — port 8000
├── packages/
│   ├── shared/           # Schemas, prospect_id, shared contracts
│   ├── db/               # Drizzle ORM client + migrations
│   ├── pal/              # Provider Abstraction Layer
│   ├── observability/    # Unified logger, Sentry, request context
│   └── opensearch/       # Search client + seed
├── workers/scrapers/     # Orchestrator, ingestor, cleaner
├── infra/                # AWS CDK stacks
└── docker-compose.yml    # Postgres + Redis for local dev
```

## Getting started

```bash
# Prerequisites: Node 20+, pnpm 9+, Docker

cp .env.example .env          # then fill keys — see § Environment variables
docker compose up -d postgres redis

pnpm install
pnpm --filter @skout/shared build
pnpm --filter @skout/db build
pnpm --filter @skout/observability build
pnpm db:migrate
pnpm db:seed                  # optional — demo workspace + credits
pnpm dev
```

API: [http://localhost:3001/api/v1/health](http://localhost:3001/api/v1/health)

Frontend (separate repo): `cd "../Skout Ai Frontend" && pnpm dev` → [http://localhost:3000](http://localhost:3000)

## Observability

### Where to analyze logs

| Environment | Where | How |
| --- | --- | --- |
| **Local** | Terminal running `pnpm dev` | JSON lines from Pino (`service`, `module`, `requestId`, `msg`, …) |
| **AWS dev/prod** | [CloudWatch Logs](https://console.aws.amazon.com/cloudwatch/home#logsV2:log-groups) | Log groups: `/skout/dev/api`, `/skout/dev/web`, `/skout/dev/ai` |
| **AWS — search** | CloudWatch **Logs Insights** | Select log group → Run query (examples below) |
| **Errors** | [Sentry](https://sentry.io) | When `SENTRY_DSN` is set — 5xx exceptions auto-captured |
| **Alarms** | CloudWatch Alarms → SNS email | ALB 5xx, API CPU, RDS CPU, API log errors |

**Dev API URL:** `https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com/api/v1`

### CloudWatch Logs Insights — example queries

Log group: `/skout/dev/api`

```sql
# Recent errors
fields @timestamp, module, msg, requestId, userId, workspaceId
| filter level = 50
| sort @timestamp desc
| limit 50

# Slow requests (> 1s)
fields @timestamp, httpMethod, httpPath, statusCode, responseTimeMs
| filter msg = "request completed" and responseTimeMs > 1000
| sort responseTimeMs desc
| limit 20

# Trace one request
fields @timestamp, module, msg, @message
| filter requestId = "YOUR-REQUEST-ID"
| sort @timestamp asc
```

### Unified logger (`@skout/observability`)

Use in any backend service:

```typescript
import { createLogger } from "@skout/observability";

const log = createLogger("crm.service");

log.info("HubSpot import started", { workspaceId, listId });
log.error("Export failed", err, { listId });
```

Each log includes `service`, `module`, optional `requestId` / `userId` / `workspaceId`, and **redacts** secrets (`authorization`, `*.apiKey`, tokens, etc.).

### Test observability locally

```bash
# One-shot smoke test (health, headers, rate limit, AI, env keys)
pnpm test:observability
# or: ./scripts/test-observability.sh
```

**Note:** `/api/v1/health` is **allowlisted** for rate limiting — it always returns `200`. The script tests rate limits on `/api/v1/me` instead.

```bash
# 1. Start stack
docker compose up -d postgres redis
pnpm dev
# AI service (separate — port 8000):
docker compose -f docker-compose.yml -f docker-compose.local.yml up ai -d

# 2. Verbose logs
# In .env set: LOG_LEVEL=debug

# 3. Health check — watch terminal for JSON log line
curl -s http://localhost:3001/api/v1/health

# 4. Request ID — every response includes x-request-id
curl -i http://localhost:3001/api/v1/health | grep -i x-request-id

# 5. Rate limit — health is exempt; use another route:
for i in $(seq 1 210); do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/v1/me; done

# 6. Sentry (optional) — add real SENTRY_DSN to .env, trigger a 500:
#    Temporarily break something or hit an unhandled error; check sentry.io Issues

# 7. Security headers
curl -I http://localhost:3001/api/v1/health | grep -iE 'x-frame|x-content|strict'

# 8. AI + PostHog
curl -X POST http://localhost:8000/v1/classify \
  -H "Content-Type: application/json" \
  -d '{"thread_id":"test-1","content":"hello"}'
```

## Environment variables

### File locations

| File | Repo | Purpose |
| --- | --- | --- |
| `.env` | Backend | Local API — **gitignored**, your real keys |
| `.env.example` | Backend | Template — committed, safe to share |
| `.env.local` | Frontend | Local Next.js — **gitignored** |
| `.env.example` | Frontend | Template |
| AWS Secrets Manager | Deployed | `SkoutDev/*` secrets (see below) |

### Backend `.env` — key reference

| Variable | Required locally? | Where to get the value |
| --- | --- | --- |
| `DATABASE_URL` | Yes | `postgresql://skout:skout@localhost:5434/skout` (docker compose) |
| `CLERK_SECRET_KEY` | Yes (or `AUTH_STUB=true`) | [Clerk Dashboard](https://dashboard.clerk.com) → API Keys |
| `CLERK_PUBLISHABLE_KEY` | Yes | Same Clerk page (also in frontend `.env.local`) |
| `INTEGRATION_ENCRYPTION_KEY` | Yes for BYOK | Run: `openssl rand -base64 32` |
| `HUBSPOT_CLIENT_ID` / `SECRET` | For CRM | [HubSpot Developer](https://developers.hubspot.com) → Project → Auth |
| `API_PUBLIC_URL` | For HubSpot OAuth | Local: `http://localhost:3001` · AWS: ALB/API Gateway URL |
| `OPENAI_API_KEY` | For AI enrich | [OpenAI Platform](https://platform.openai.com/api-keys) |
| `HUNTER_API_KEY`, etc. | Optional | Each provider's dashboard (see `.env.example` comments) |
| `OPENSEARCH_URL` | For search | Bonsai / self-hosted / docker local |
| `SENTRY_DSN` | Node API | `Skout AI Backend/.env` | Sentry → **nodejs** project → Client Keys |
| `SENTRY_DSN` | Python AI | `apps/ai/.env` | Sentry → **python** project → Client Keys |
| `NEXT_PUBLIC_SENTRY_DSN` | Frontend | `Skout Ai Frontend/.env.local` | Sentry → **frontend** project → Client Keys |
| `POSTHOG_API_KEY` | API (future) / AWS | `.env` / Secrets Manager | PostHog → Settings → Project API key (`phc_…`) |
| `POSTHOG_PROJECT_TOKEN` | Python AI | `apps/ai/.env` | Same `phc_…` key as PostHog |
| `POSTHOG_HOST` | All | `https://us.i.posthog.com` | US Cloud ingest |
| `DD_API_KEY` | AWS ECS | `.env` / Secrets Manager | See **Datadog** section below |
| `DD_SITE` | AWS ECS | `us5.datadoghq.com` | Your Datadog site (US5) |
| `LOG_LEVEL` | Optional | `debug` \| `info` \| `warn` \| `error` (default `info`) |
| `SERVICE_NAME` | Optional | Default `skout-api` |
| `TRUST_PROXY` | Optional | `false` locally · `true` on AWS behind ALB |

### Frontend `.env.local` — key reference

| Variable | Where to get |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:3001` locally |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk Dashboard → API Keys |
| `CLERK_SECRET_KEY` | Same (server-side Next.js) |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry → **Frontend** project DSN (optional) |
| `NEXT_PUBLIC_POSTHOG_KEY` | PostHog project API key (optional) |

### Datadog (ECS Fargate — not serverless)

Skout runs on **ECS Fargate**, not Lambda. The `npx @datadog/ai-setup-cli` serverless wizard will **not** work here.

**Where to get Datadog keys** (your site: [us5.datadoghq.com](https://us5.datadoghq.com)):

| Key | Where in Datadog UI |
| --- | --- |
| **API Key** (`DD_API_KEY`) | [Organization Settings → API Keys](https://us5.datadoghq.com/organization-settings/api-keys) → **New Key** |
| **Application key** (optional, for API automation) | Organization Settings → Application Keys |
| **RUM client token** (frontend, phase 2) | Digital Experience → RUM → Applications → New Application |
| **RUM application ID** (frontend, phase 2) | Same RUM application page |

Add to `.env`:
```env
DD_API_KEY=your_api_key_here
DD_SITE=us5.datadoghq.com
```

**ECS setup (manual, next step):** Datadog Agent sidecar on Fargate task + `dd-trace` in the API image. Ask when ready to wire CDK.

### AWS Secrets Manager (deployed dev)

After deploy, update secrets (not `.env`):

```bash
# Sentry (three DSNs — node, python, frontend)
aws secretsmanager put-secret-value --secret-id SkoutDev/sentry \
  --secret-string '{
    "SENTRY_DSN":"https://YOUR_NODE_DSN@....ingest.us.sentry.io/...",
    "SENTRY_DSN_AI":"https://YOUR_PYTHON_DSN@....ingest.us.sentry.io/...",
    "SENTRY_DSN_WEB":"https://YOUR_FRONTEND_DSN@....ingest.us.sentry.io/..."
  }'

# PostHog
aws secretsmanager put-secret-value --secret-id SkoutDev/posthog \
  --secret-string '{
    "POSTHOG_API_KEY":"phc_...",
    "POSTHOG_HOST":"https://us.i.posthog.com",
    "POSTHOG_PROJECT_ID":"475854"
  }'

# BYOK encryption
aws secretsmanager put-secret-value --secret-id SkoutDev/app-config \
  --secret-string '{"INTEGRATION_ENCRYPTION_KEY":"YOUR_BASE64_KEY"}'

# HubSpot
aws secretsmanager put-secret-value --secret-id SkoutDev/hubspot \
  --secret-string '{"HUBSPOT_CLIENT_ID":"...","HUBSPOT_CLIENT_SECRET":"..."}'
```

Full list: [`docs/secrets-setup.md`](docs/secrets-setup.md) · [`infra/README.md`](infra/README.md)

## Database (Drizzle ORM)

Schema, client, and migrations live in **`packages/db`** (`@skout/db`). The API receives a typed Drizzle client via `app.db` when `DATABASE_URL` is set.

```bash
docker compose up -d
pnpm db:migrate
pnpm db:seed          # optional
```

**When you change the schema** (`packages/db/src/schema/*.ts`):

```bash
pnpm db:generate
pnpm db:migrate
```

| Command | Description |
| --- | --- |
| `pnpm db:generate` | Diff schema → new migration in `packages/db/drizzle/` |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:seed` | Demo workspace + credits + sample list |
| `pnpm db:push` | Push schema directly (dev only) |
| `pnpm db:studio` | Drizzle Studio GUI |

## MVP API surface (selected)

```
GET  /api/v1/health
GET  /api/v1/workspaces/current
POST /api/v1/search/prospects
GET  /api/v1/lists
POST /api/v1/lists
GET  /api/v1/crm/connections
POST /api/v1/crm/hubspot/connect
POST /api/v1/crm/hubspot/import
GET  /api/v1/integrations
```

## Pre-commit hooks

```bash
pnpm test   # vitest across workspace packages
```

Install hooks: `pnpm install` (runs husky `prepare`).

### AI service (optional)

```bash
cd apps/ai
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn src.main:app --reload --port 8000
```

## Related repo

Frontend: **`Skout Ai Frontend`** (Next.js on port 3000).

**Repo layout:** [docs/repo-structure.md](docs/repo-structure.md)

## Deployment

| Environment | Branch | How |
| --- | --- | --- |
| **Local** | any | `docker compose up -d` + `pnpm dev` |
| **Dev** | `develop` | Push → GitHub Actions → AWS ECS |
| **UAT** | `uat` | Coming soon |
| **Prod** | `main` | GitHub Actions → AWS ECS |

```bash
pnpm infra:local-env
pnpm infra:synth:dev
pnpm infra:deploy:dev
```

Branching: [`docs/git-workflow.md`](docs/git-workflow.md) · Environments: [`docs/deployment-environments.md`](docs/deployment-environments.md)

## Build order (from development plan)

1. Search API + Redis cache + OpenSearch index
2. Activation pipeline → PostgreSQL
3. Email infra + sequences
4. AI Gateway + HITL queue
5. Temporal + Kafka at v1 scale
