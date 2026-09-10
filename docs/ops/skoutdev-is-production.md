# SkoutDev is production (this AWS account)

**Decision (2026-08-26):** Account `119408973331` runs a **single** ECS environment: **`SkoutDev-cluster`**.  
There is no separate `SkoutProd-*` stack. Treat **SkoutDev as production** for §11.1, RBAC, consent, encryption, SSO, and go-live checklists.

| Former wording | Meaning now |
|----------------|-------------|
| SkoutProd / `env=prod` | **Not used** in this account — do not create a second cluster |
| SkoutDev / `env=dev` | **Production** cluster + ECR (`skout-dev-*`) + secrets (`SkoutDev/*`) |
| `deploy-prod.yml` | Keep for a future multi-env split; current releases = `deploy-dev.yml` / `develop` |

## Verified live on SkoutDev (2026-08-26)

| Control | Status |
|---------|--------|
| `RBAC_ENFORCEMENT_ENABLED` | `true` (API + CRM) |
| `CONSENT_ENFORCEMENT_ENABLED` | `true` (API) |
| Integration encryption rotation | Executed 2026-08-26 (Tier‑1); next window 2026-11-23 |
| SSO / SCIM Stage‑6 APIs | Live (`/api/v1/sso/*`) |
| Image tag | `dev-71b92ef` (API/CRM/web/AI) |

## Scripts

Use **`SkoutDev`** as the stack prefix everywhere former docs said `SkoutProd`:

```bash
./scripts/ecs-run-migrations.sh SkoutDev
./scripts/ecs-run-backfill-rbac.sh SkoutDev
./infra/scripts/setup-email-intel-forwarder.sh SkoutDev <API_URL>
```
