# Skout AI — Backend

Monorepo for the Skout AI platform backend, aligned with the production blueprint and system components catalog.

## Stack

| Layer | Technology |
| --- | --- |
| Core API | Node.js, TypeScript, **Fastify** |
| AI Service | Python, **FastAPI**, LiteLLM (stub) |
| Shared types | `@skout/shared` (Zod schemas, identity) |
| OLTP | PostgreSQL (activated records only) |
| Cache / queues | Redis, BullMQ (MVP) → Temporal + Kafka (v1) |
| Search / analytics | OpenSearch + ClickHouse (wire in staging) |

## Structure

```
Skout AI Backend/
├── apps/
│   ├── api/              # Core REST API (Fastify) — port 3001
│   └── ai/               # AI orchestration (FastAPI) — port 8000
├── packages/
│   ├── shared/           # Schemas, prospect_id, shared contracts
│   └── pal/              # Provider Abstraction Layer (planned)
├── workers/              # Async worker pools (BullMQ → Temporal)
├── database/
│   └── migrations/       # PostgreSQL DDL (workspace OLTP)
├── docs/
│   └── adr/              # Architecture Decision Records
└── docker-compose.yml    # Postgres + Redis for local dev
```

## MVP API surface

```
GET  /api/v1/health
GET  /api/v1/workspaces
POST /api/v1/search/prospects
GET  /api/v1/search/prospects/:id
GET  /api/v1/prospects
POST /api/v1/prospects/:id/enrich          → 202 Accepted
GET  /api/v1/lists
POST /api/v1/lists
GET  /api/v1/sequences
POST /api/v1/sequences/:id/enroll          → 202 Accepted
GET  /api/v1/inboxes
GET  /api/v1/domains
GET  /api/v1/inbox/threads
GET  /api/v1/ai/drafts
GET  /api/v1/crm/connections
GET  /api/v1/webhooks
```

## Getting started

```bash
# Prerequisites: Node 20+, pnpm 9+, Docker

cp .env.example .env
docker compose up -d

pnpm install
pnpm --filter @skout/shared build
pnpm dev
```

API: [http://localhost:3001/api/v1/health](http://localhost:3001/api/v1/health)

## Pre-commit hooks

Husky runs unit tests across all workspace packages before each commit:

```bash
pnpm test   # vitest run in @skout/shared + @skout/api
```

Install hooks after clone: `pnpm install` (runs `prepare` → husky).

### AI service (optional)

```bash
cd apps/ai
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn src.main:app --reload --port 8000
```

## Related repo

Frontend: `Skout Ai Frontend` (Next.js on port 3000).

## Deployment

| Environment | How to run |
| --- | --- |
| **Local** | Backend: `pnpm docker:local` or `docker compose up -d` + `pnpm dev`. Frontend: see `Skout Ai Frontend` repo |
| **Dev** | Push to **`develop`** → GitHub Actions deploys to AWS |
| **UAT** | Push to **`uat`** (sandbox — coming soon) |
| **Prod** | Push to **`main`** → GitHub Actions deploys to AWS |

```bash
pnpm infra:local-env          # Generate local .env files
pnpm infra:synth:dev          # Preview dev CloudFormation
pnpm infra:deploy:dev         # Deploy dev stacks (manual)
```

Full infrastructure docs: [`infra/README.md`](infra/README.md)

Branching, PRs, and releases: [`docs/git-workflow.md`](docs/git-workflow.md)

## Build order (from development plan)

1. Search API + Redis cache + OpenSearch index
2. Activation pipeline → PostgreSQL
3. Email infra + sequences
4. AI Gateway + HITL queue
5. Temporal + Kafka at v1 scale
