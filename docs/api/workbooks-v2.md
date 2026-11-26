# Workbooks V2 API: CRUD (WB2-011)

Base path `/api/v1/workbooks-v2`. Rows (WB2-012) and columns (WB2-013) are not here yet.

**Access.** The workspace must have the `workbooks_v2` switch (`docs/ops/workbooks-v2-flag.md`), otherwise `403 feature_disabled`. Reading needs `enrichment:read`; creating or changing needs `enrichment:capture`. The workspace always comes from the signed-in session; request bodies with unknown fields (including `workspaceId`, `rowLimit`, `rowCount`) are rejected.

| Method and path | Body | Success | Errors besides 401/403/422 |
|---|---|---|---|
| `POST /` | `{ "name" }` | `201 { data: Workbook }` | |
| `GET /?page=&pageSize=` | | `200 { data: Summary[], total, page, pageSize }`, newest edit first; `pageSize` ≤ 100 | |
| `GET /:id` | | `200 { data: Workbook }` | `404` |
| `PATCH /:id` | `{ "name" }` | `200 { data: Workbook }` | `404` |
| `POST /:id/duplicate` | `{ "includeRows": boolean, "name"? }` | `201 { data: Workbook }` | `404`, `422 ROW_LIMIT_EXCEEDED`, `429` (10 a minute) |
| `DELETE /:id` | | `200 { data: { id, deletedAt, restorableUntil } }` | `404` |
| `POST /:id/restore` | | `200 { data: Workbook }` | `404`, `409 WORKBOOK_NOT_DELETED`, `410 RESTORE_WINDOW_EXPIRED` |

`name` is 1–200 characters after trimming. A workbook that is missing, soft-deleted or another workspace's answers `404 NOT_FOUND` everywhere except `restore`.

```ts
Summary  = { id, name, rowCount, rowLimit, columnCount,
             lastRun: { id, columnId, status, createdAt, startedAt, finishedAt } | null,
             createdBy: { id, name, email } | null, createdAt, updatedAt /* last edited */ }
Workbook = Summary & { columns: { id, name, type, operation, config, position, width, hidden, frozen }[], archivedSourceId }
```

Errors use the standard envelope: `{ ok: false, code, error, message, statusCode, details, request_id, retryable }`.

## Idempotency
`POST /` and `POST /:id/duplicate` accept an optional `Idempotency-Key` (8–128 characters). A repeat with the same key and body returns the first answer; the same key with a different body is `IDEMPOTENCY_KEY_REUSED`; one still running is `409`. Without the header, each request creates a workbook.

## Row limit
Rows per workbook default to 100,000. CustomerOps changes it per workspace with the platform-managed entitlement `workbooks.row_limit` (a non-negative integer), through `PUT /api/v1/admin/workspaces/:workspaceId/entitlements/workbooks.row_limit` with `{ "value": 250000 }`; a workspace cannot set its own. Anything that adds rows must check `getWorkspaceRowLimit()` (`workbook-v2.service.ts`); the stored `workbooks.row_limit` is only the value at creation.

## Duplicate
Copies columns (column ids inside configs are rewritten) and, with `includeRows`, rows and cells. Not copied: runs, imports, saved views, webhooks, and cells that are queued or running. Copied cells have `credits_charged = 0`. The copy runs in one transaction inside the request: about 19 s for 100,000 rows × 20 columns on a 2 CPU / 2 GiB database.

## Delete and restore
Delete is soft; data is kept. Restore works up to 30 days after deletion. Nothing purges expired workbooks yet. Both actions are written to the audit log.
