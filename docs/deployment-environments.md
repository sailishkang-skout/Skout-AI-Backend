# Skout AI — Branch → Environment Mapping

> For branch creation, PR workflow, and release naming, see [git-workflow.md](./git-workflow.md).

| Git branch | Environment | AWS CDK | Deploy workflow | Env files |
|------------|-------------|---------|-----------------|-----------|
| **local** | Local machine | None (Docker Compose) | — | `.env`, `.env.local` |
| **develop** | **Production** (this account) | `SkoutDev-*` | `deploy-dev.yml` | `.env.dev` |
| **uat** | UAT / sandbox | `SkoutUat-*` (coming soon) | `deploy-uat.yml` (placeholder) | `.env.uat` |
| **main** | Optional future 2nd prod | `SkoutProd-*` | `deploy-prod.yml` | `.env.prod` |

> **2026-08-26:** Account `119408973331` has **only** `SkoutDev-cluster`. Treat it as production — [`docs/ops/skoutdev-is-production.md`](./ops/skoutdev-is-production.md).

## Env file layout

### Backend (`Skout AI Backend`)

| File | Purpose | Committed? |
|------|---------|------------|
| `.env` | Local development | No (gitignored) |
| `.env.example` | Local template | Yes |
| `.env.dev` | Dev AWS values (fill after deploy) | No |
| `.env.dev.example` | Dev template | Yes |
| `.env.uat.example` | UAT template (later) | Yes |
| `.env.prod.example` | Prod template (later) | Yes |

### Frontend (`Skout Ai Frontend`)

| File | Purpose | Committed? |
|------|---------|------------|
| `.env.local` | Local development | No |
| `.env.example` | Local template | Yes |
| `.env.dev` | Dev `NEXT_PUBLIC_API_URL` for builds | No |
| `.env.dev.example` | Dev template | Yes |
| `.env.uat.example` | UAT template (later) | Yes |
| `.env.prod.example` | Prod template (later) | Yes |

> **Note:** Deployed ECS tasks get env from CDK task definitions + Secrets Manager.  
> `.env.dev` files are for local reference, manual builds, and documentation.

## After first dev deploy

1. Get ALB URL from CDK:
   ```bash
   cd infra && pnpm cdk deploy --all -c env=dev --outputs-file outputs.json
   ```

2. Update backend `.env.dev` and frontend `.env.dev`:
   ```
   CORS_ORIGIN=http://YOUR_ALB_DNS
   NEXT_PUBLIC_API_URL=http://YOUR_ALB_DNS
   ```

3. Create GitHub **environment** `dev`:
   - Repo → **Settings** → **Environments** → **New environment** → name: `dev`
   - Workflows use `environment: dev`, so secrets/variables must be set on this environment (not only repo-level).

4. Set GitHub **variables** (on environment `dev`):
   - `DEV_API_URL` = `http://YOUR_ALB_DNS`

5. Set GitHub **secrets** (on environment `dev`):
   - `AWS_DEPLOY_ROLE_ARN_DEV` = from CDK output `GitHubDeployRoleArn`

6. Create AWS secret:
   ```bash
   aws secretsmanager create-secret --name SkoutDev/openai \
     --secret-string '{"OPENAI_API_KEY":"sk-..."}'
   ```

## Deploy commands

```bash
# Dev (manual)
git push origin develop          # or: pnpm infra:deploy:dev

# UAT (when ready)
git push origin uat

# Production (when ready)
git push origin main
```

## LinkedIn + Chrome extension (MVP production)

Go-live checklist for Unipile LinkedIn outreach and the Chrome extension (deploy steps + pending items):

→ **[docs/mvp/mvp-production-checklist.md](./mvp/mvp-production-checklist.md)**
