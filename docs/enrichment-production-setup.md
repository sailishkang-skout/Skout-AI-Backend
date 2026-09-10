# Lead Enrichment — Production & Local Setup Guide

> Step-by-step checklist to run enrichment, ICP, smart lists, and lists in **local dev** and **production**.  
> Auth (Clerk) is owned separately — see [auth-login-and-user-provisioning.md](./auth-login-and-user-provisioning.md).

Last updated: **2026-06-11**

---

## Why smart lists didn’t save locally (fixed)

**Cause:** Without `DATABASE_URL`, the API returned success on create but `GET /smart-lists` always returned `[]` (nothing was stored).

**Fix:** In-memory fallback when Postgres is not configured (same pattern as enrichment credits). Lists persist until you restart the API.

**For persistent local data:** use Postgres + migrations (recommended below).

---

## Part A — Local development (full stack)

### Step 1 — Start infrastructure

```bash
cd "Skout AI Backend"
docker compose up -d    # Postgres :5432 + Redis :6379
```

### Step 2 — Backend environment

```bash
cp .env.example .env
```

Minimum `.env` for enrichment + ICP + smart lists:

```bash
DATABASE_URL=postgresql://skout:skout@localhost:5432/skout
REDIS_URL=redis://localhost:6379
CORS_ORIGIN=http://localhost:3000

# Optional — real search + smart list Run
# OPENSEARCH_URL=http://localhost:9200

# Optional — live providers (else stubs)
# HUNTER_API_KEY=...
# AI_SERVICE_URL=http://localhost:8000
```

### Step 3 — Install, migrate, seed

```bash
pnpm install
pnpm --filter @skout/db migrate
pnpm --filter @skout/db seed          # demo workspace + 500 credits
pnpm dev                              # API :3001
```

### Step 4 — Frontend

```bash
cd "../Skout Ai Frontend"
cp .env.example .env.local
```

```bash
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_WORKSPACE_ID=00000000-0000-4000-8000-000000000001
```

```bash
pnpm install
pnpm dev                              # UI :3000
```

### Step 5 — Verify each feature in the UI

| Page | URL | Expect |
|------|-----|--------|
| Enrichment | `/enrichment` | Credits 500, enrich works |
| Prospect search | `/prospects/search` | Demo results, Enrich, Add to list |
| Lists | `/lists` | Create list → add prospects → Bulk enrich |
| ICP wizard | `/onboarding/icp` | Save → reload settings shows data |
| ICP settings | `/settings/icp` | Edit + save |
| Smart lists | `/smart-lists` | Create → appears in list below |

**Smart list Run:** needs `OPENSEARCH_URL` on the API. Without it you get a clear error; **save** still works.

### Step 6 — Restart API after `.env` changes

```bash
# Stop and re-run pnpm dev
```

---

## Part B — Production deployment (step by step)

Assumes AWS CDK stacks exist (`SkoutProd-*` or `SkoutDev-*` for staging first).

### Step 1 — Merge code to the deploy branch

```bash
# Backend
git checkout develop   # or main for prod
git merge feature/lead-enrichment-automatation
git push origin develop

# Frontend
git merge feature/lead-enrichment-automation
git push origin develop
```

GitHub Actions builds Docker images → ECR → CDK deploy → **migrations** → ECS redeploy.

### Step 2 — Confirm deploy health

```bash
curl https://YOUR_ALB_DNS/api/v1/health
# → {"status":"ok"}
```

Check GitHub Actions workflow completed without errors.

### Step 3 — Confirm database migrations

Migrations run automatically on API container start (`apps/api/docker-entrypoint.sh`) or via `scripts/ecs-run-migrations.sh`.

Required tables include: `smart_lists`, `workspace_icp`, `enrichment_jobs`, `scrape_jobs`, etc.

If ICP/smart lists fail silently, run migrations manually (one-off ECS task or bastion):

```bash
# From repo, against prod RDS (with credentials)
DATABASE_URL=postgresql://... pnpm --filter @skout/db migrate
```

### Step 4 — Fill AWS Secrets Manager

Replace `replace-me` placeholders. Prefix: **`SkoutProd`** (or `SkoutDev` for staging).

| Secret | Required for | Command |
|--------|--------------|---------|
| `{Prefix}/database` | Auto by CDK | Do not change unless rotating |
| `{Prefix}/enrichment-providers` | Live enrich (email, firmographics, phone) | See below |
| `{Prefix}/hunter` | Email finder | `./scripts/put-secret.sh SkoutProd hunter '{"HUNTER_API_KEY":"..."}'` |
| `{Prefix}/openai` | LLM pain points / personalize | `OPENAI_API_KEY` |
| `{Prefix}/opensearch` | Smart list **Run** + real search | Bonsai URL + user + password |

**Enrichment providers (one JSON blob):**

```bash
./scripts/put-secret.sh SkoutProd enrichment-providers '{
  "MILLIONVERIFIER_API_KEY":"...",
  "ZEROBOUNCE_API_KEY":"...",
  "NEVERBOUNCE_API_KEY":"...",
  "PDL_API_KEY":"...",
  "REVENUEBASE_API_KEY":"...",
  "EXPLORIUM_API_KEY":"...",
  "CORESIGNAL_API_KEY":"...",
  "DATAGMA_API_KEY":"...",
  "COGNISM_API_KEY":"...",
  "OPENCORPORATES_API_KEY":"..."
}'
```

Details: [enrichment-credentials.md](./enrichment-credentials.md)

**OpenSearch (Bonsai recommended):**

```bash
aws secretsmanager put-secret-value --secret-id SkoutProd/opensearch \
  --secret-string '{
    "OPENSEARCH_URL":"https://xxxx.bonsaisearch.net",
    "OPENSEARCH_USERNAME":"...",
    "OPENSEARCH_PASSWORD":"..."
  }'
```

### Step 5 — Redeploy ECS after secret updates

Secrets are loaded at task start — existing tasks won’t pick up new values.

```bash
pnpm --filter @skout/infra redeploy:prod
# or
aws ecs update-service --cluster SkoutProd-cluster --service api --force-new-deployment
aws ecs update-service --cluster SkoutProd-cluster --service web --force-new-deployment
aws ecs update-service --cluster SkoutProd-cluster --service ai --force-new-deployment
```

### Step 6 — Auth team (parallel track)

Your teammate must wire Clerk so production gets:

- JWT on every API call (`Authorization: Bearer …`)
- Real `workspace_id` per customer (not demo UUID)
- First-login provisioning (`users`, `workspace_members`, `credit_balances`)

Until then, enrichment works only with the dev stub header — not for real customers.

Frontend change when auth lands: remove reliance on `NEXT_PUBLIC_WORKSPACE_ID`; use session workspace from Clerk.

### Step 7 — Verify production API (smoke tests)

```bash
export API=https://YOUR_ALB_DNS
export WS=00000000-0000-4000-8000-000000000001   # replace after auth

curl "$API/api/v1/enrichment/credits" -H "X-Workspace-Id: $WS"
curl "$API/api/v1/smart-lists" -H "X-Workspace-Id: $WS"
curl -X PUT "$API/api/v1/workspace/icp" -H "Content-Type: application/json" -H "X-Workspace-Id: $WS" \
  -d '{"industries":["Software"],"countries":["US"]}'
```

### Step 8 — Verify production UI

| Flow | Path |
|------|------|
| Enrich one prospect | `/enrichment` |
| Search → add to list → bulk enrich | `/prospects/search` → `/lists` |
| ICP | `/onboarding/icp`, `/settings/icp` |
| Smart lists | `/smart-lists` |

---

## Part C — What each feature needs in production

| Feature | Postgres | Redis | OpenSearch | Provider keys | Scraper workers |
|---------|----------|-------|------------|---------------|-----------------|
| Enrich console | ✅ (persist jobs) | — | — | Optional (stubs OK) | — |
| Lists + bulk enrich | ✅ | — | — | Optional | — |
| ICP save/load | ✅ | — | — | — | — |
| Smart list **save** | ✅ | — | — | — | — |
| Smart list **Run** | ✅ | — | ✅ | — | — |
| Real prospect search | — | — | ✅ + indexed data | — | ✅ (Tier 1) |
| Corpus pipeline | ✅ | ✅ | ✅ | OpenCorporates optional | ✅ **Not in CDK yet** |

---

## Part D — Tier 1 corpus (optional, for real search data)

Scraper ECS services are **not** in CDK yet. To populate OpenSearch in production:

1. Build & push images to ECR: `scraper-orchestrator`, `scraper-cleaner`, `scraper-ingestor`
2. Add three Fargate services (same VPC, Redis, RDS, S3, OpenSearch env as API)
3. Start workers:
   ```bash
   pnpm --filter @skout/scraper-orchestrator start
   pnpm --filter @skout/scraper-cleaner start
   pnpm --filter @skout/scraper-ingestor start
   ```
4. Trigger jobs: `POST /api/v1/scrape/jobs` with `{ "source": "company-web", "seeds": ["acme.com"] }`

---

## Part E — Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Smart lists empty after create | No `DATABASE_URL` (old bug) or API not restarted | Pull latest API; set `DATABASE_URL` + migrate; restart API |
| Smart list Run fails | No OpenSearch | Set `OPENSEARCH_URL` in API env / Secrets Manager |
| ICP doesn’t persist | No Postgres | `DATABASE_URL` + migrate |
| Enrich returns stub data | No provider keys | Fill `enrichment-providers` + `hunter` secrets |
| Bulk enrich disabled | List has 0 prospects | Search → select → Add to list |
| 402 on enrich | No credits | Seed workspace or check `credit_balances` |
| CORS errors | Wrong origin | `CORS_ORIGIN` = exact frontend URL |
| UI can’t reach API | Wrong URL | `NEXT_PUBLIC_API_URL` = ALB `/api` base |

---

## Quick reference — local one-liner

```bash
# Terminal 1 — Backend
docker compose up -d && pnpm --filter @skout/db migrate && pnpm --filter @skout/db seed && pnpm dev

# Terminal 2 — Frontend
pnpm dev
```

Then open http://localhost:3000/smart-lists and create a list — it should appear immediately (memory or Postgres).

---

## Related docs

- [data-enrichment-implementation-status.md](./data-enrichment-implementation-status.md)
- [enrichment-credentials.md](./enrichment-credentials.md)
- [secrets-setup.md](./secrets-setup.md)
- [deployment-environments.md](./deployment-environments.md)
