# SkoutProd — first deploy checklist

> **Superseded for this AWS account (2026-08-26).**  
> There is **no** `SkoutProd` cluster. **SkoutDev is production** — see  
> [`skoutdev-is-production.md`](./skoutdev-is-production.md).

Historical `env=prod` / `deploy-prod.yml` steps below are kept only if leadership later splits a second account/env.

---

## Current production (SkoutDev) — done

- [x] ECS cluster `SkoutDev-cluster` live  
- [x] `RBAC_ENFORCEMENT_ENABLED=true` + backfill path (`./scripts/ecs-run-backfill-rbac.sh SkoutDev`)  
- [x] Email-Intel → Evidence forwarder on SkoutDev  
- [x] `CONSENT_ENFORCEMENT_ENABLED=true`  
- [x] SSO/SCIM Stage‑6 APIs (`docs/ops/sso-stage6-checklist.md`)  
- [x] Encryption Tier‑1 rotation executed 2026-08-26  

## Legacy: create a *separate* SkoutProd (optional future)

Only if leadership provisions a second env:

### 0. Prerequisites

- [ ] GitHub `production` environment + `AWS_DEPLOY_ROLE_ARN_PROD` OIDC role  
- [ ] Full Secrets Manager set under `SkoutProd/*`  
- [ ] Optional: `PROD_DOMAIN_NAME`

### 1. Deploy stack

```bash
# GitHub Actions → Deploy Production (workflow_dispatch on main)
# Or: cd infra && pnpm deploy:prod
```

### 2–7

Same as former RBAC / forwarder / consent / SSO / encryption / smoke steps, with prefix `SkoutProd`.

**Owner:** Neeraj (Ops/SRE)  
**Status:** **Closed on SkoutDev-as-prod 2026-08-26** — separate SkoutProd not required.
