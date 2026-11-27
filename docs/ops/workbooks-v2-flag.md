# WORKBOOKS_V2 feature flag (WB2-002)

Controls access to the new Workbooks V2 experience, one workspace at a time. It is stored and read the same way as the other product feature switches (`feature.<key>` entitlements, see `packages/shared/src/product-features.ts`), with one difference: **it is off unless explicitly granted** (`OPT_IN_FEATURES`).

| | |
|---|---|
| Key | `workbooks_v2` (entitlement `feature.workbooks_v2`) |
| Default | **off**. No row, a `false` row, or any value other than boolean `true` all mean off. |
| Gated API | everything under `/api/v1/workbooks-v2/*` → `403 feature_disabled` (`feature: "workbooks_v2"`) |
| Not gated | the legacy `/api/v1/workbooks/*` routes. They stay under the `enrichment` switch and are unchanged. |
| Read by the app | `GET /api/v1/access-request` → `data.features.workbooks_v2` for the signed-in user's own workspace |

## Turn it on or off for a workspace

Through COPS (needs the COPS write permission and an `Idempotency-Key`):

```
PUT /api/v1/cops/workspaces/:workspaceId/features
{ "features": { "workbooks_v2": true } }      # false to turn it off again
```

The change is audited (`access.features_changed`) and applies to the process that handled it at once and to the others within 30 seconds (`WORKSPACE_ACCESS_TTL_MS`).

Customers cannot grant it to themselves: `feature.*` entitlements are platform-managed (`PUT /entitlements/feature.workbooks_v2` → 403). Approving an early-access request never turns it on; the plan presets leave it off, and the approve call may omit it.

## How a request is decided

`accessGuard` runs after authentication, on the workspace the user is actually a member of. `X-Workspace-Id` is honoured only for a workspace the user belongs to (otherwise 403), so a user cannot borrow another workspace's flag. If the flag cannot be loaded the guard throws (500); it never lets the request through.

## Frontend

`workbooks_v2` in `src/lib/feature-nav.ts` is also opt-in there: a missing, loading, or failed flag shows the existing Workbooks only, the sidebar entry is hidden, and `/enrichment/workbooks-v2` shows "not on your plan".
