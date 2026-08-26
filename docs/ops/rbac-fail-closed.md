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

ECS one-off command: `node /app/node_modules/@skout/db/dist/backfill-rbac.js`  
(Requires an API image that includes `backfill-rbac.js` — rebuild/push if the file is missing.)

## Enable per env (approve each)
| Env | Flag | Status |
|-----|------|--------|
| local | `RBAC_ENFORCEMENT_ENABLED=true` | ON (this machine) |
| SkoutDev | same after backfill on that DB | **ON 2026-08-25** — backfill 14 grants / 14 workspaces; live on API TD `:171` + CRM `:86` |
| prod | same | Awaiting Leadership approve + prod backfill (#4) |

Startup refuses enforce if grants are empty (`assertRbacBackfillReady`).
