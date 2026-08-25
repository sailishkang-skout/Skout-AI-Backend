# Fail-closed RBAC

## What backfill needs
Existing rows only — no external file:

1. `workspaces` → tenant rows  
2. `workspace_members` (userId + role text) → `workspace_member_roles`  
3. Seeds permission/role catalogs  

```bash
# Local DB
pnpm --filter @skout/db backfill-rbac

# SkoutDev / Prod (same VPC as API — preferred)
./scripts/ecs-run-backfill-rbac.sh SkoutDev
# Confirm: SELECT count(*) FROM workspace_member_roles;  -- must be > 0
```

Image path used by the ECS one-off: `node /app/db/dist/backfill-rbac.js`.

## Enable per env (approve each)
| Env | Flag | Status |
|-----|------|--------|
| local | `RBAC_ENFORCEMENT_ENABLED=true` | ON (this machine) |
| SkoutDev | same after backfill on that DB | **Complete 2026-08-25** — backfill OK (14 grants); flag live on API+CRM |
| prod | same | **Approved 2026-08-25** — CDK sets flag; run backfill on first SkoutProd deploy |

Startup refuses enforce if grants are empty (`assertRbacBackfillReady`).
