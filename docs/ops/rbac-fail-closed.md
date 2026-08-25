# Fail-closed RBAC

## What backfill needs
Existing rows only — no external file:

1. `workspaces` → tenant rows  
2. `workspace_members` (userId + role text) → `workspace_member_roles`  
3. Seeds permission/role catalogs  

```bash
pnpm --filter @skout/db backfill-rbac
# Confirm: SELECT count(*) FROM workspace_member_roles;  -- must be > 0
```

## Enable per env (approve each)
| Env | Flag | Status |
|-----|------|--------|
| local | `RBAC_ENFORCEMENT_ENABLED=true` | ON (this machine) |
| SkoutDev | same after backfill on that DB | Awaiting your approve |
| prod | same | Awaiting your approve |

Startup refuses enforce if grants are empty (`assertRbacBackfillReady`).
