# Workbooks V2 API: workbooks (WB2-011) and rows (WB2-012)

Base path `/api/v1/workbooks-v2`. Columns (WB2-013) are not here yet.

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
`POST /`, `POST /:id/duplicate`, `POST /:id/rows` and `POST /:id/rows/bulk` accept an optional `Idempotency-Key` (8–128 characters). A repeat with the same key and body returns the first answer; the same key with a different body is `IDEMPOTENCY_KEY_REUSED`; one still running is `409`. Without the header, each request creates a new workbook or new rows.

## Row limit
Rows per workbook default to 100,000. CustomerOps changes it per workspace with the platform-managed entitlement `workbooks.row_limit` (a non-negative integer), through `PUT /api/v1/admin/workspaces/:workspaceId/entitlements/workbooks.row_limit` with `{ "value": 250000 }`; a workspace cannot set its own. Anything that adds rows must check `getWorkspaceRowLimit()` (`workbook-v2.service.ts`); the stored `workbooks.row_limit` is only the value at creation.

## Duplicate
Copies columns (column ids inside configs are rewritten) and, with `includeRows`, rows and cells. Not copied: runs, imports, saved views, webhooks, and cells that are queued or running. Copied cells have `credits_charged = 0`. The copy runs in one transaction inside the request: about 19 s for 100,000 rows × 20 columns on a 2 CPU / 2 GiB database.

## Delete and restore
Delete is soft; data is kept. Restore works up to 30 days after deletion. Nothing purges expired workbooks yet. Both actions are written to the audit log.

## Rows

Same access rules as above: reading (including `rows/query`) needs `enrichment:read`; adding, editing and deleting need `enrichment:capture`. Every id is checked against the session's workspace and then against the workbook in the path.

| Method and path | Body | Success | Errors besides 401/403/422 validation |
|---|---|---|---|
| `GET /:id/rows?offset=&limit=&columnIds=a,b` | | `200 Window` | `404`, `422 UNKNOWN_COLUMN` |
| `POST /:id/rows/query` | `{ offset?, limit?, sort?, filters?, search?, columnIds? }` | `200 Window` | `404`, `422 UNKNOWN_COLUMN` |
| `POST /:id/rows` | `NewRow` | `201 { data: Row, rowCount }` | `404`, cell errors, `422 ROW_LIMIT_EXCEEDED` |
| `POST /:id/rows/bulk` | `{ rows: NewRow[] }`, 1–1,000, body ≤ 5 MB | `201 { data: { added, rowCount, rows: [{ id, position }], invalidCells } }` | as above, `413` |
| `PATCH /:id/rows/:rowId` | `{ cells }`, at least one | `200 { data: Row }` | `404`, cell errors |
| `DELETE /:id/rows/:rowId` | | `200 { data: { deleted, rowCount } }` | `404` |
| `POST /:id/rows/delete` | `{ rowIds }`, 1–10,000 | `200 { data: { deleted, rowCount } }` | `404` |

```ts
NewRow = { cells?: { [columnId]: string | number | boolean | null },   // at most 200
           source?: { type: string, ...up to 19 text/number/boolean/null fields },  // default { type: "manual" }
           crmRef?: { provider: string, id: string } }
Row    = { id, position, source, prospectId, crmRef, suppressed, createdAt,
           cells: { [columnId]: { value, state, confidence, creditsCharged, foundVia, errorCode, updatedAt } } }
Window = { data: (Row & { index })[],
           window: { offset, limit, returned, matched, total, hasMore, nextOffset } }
```

`position`, `prospectId`, `suppressed` and ids are set by the server; unknown fields are refused. Internal cell provenance is never returned, filtered on or searched.

### Writing
- Every write is one transaction that locks the workbook, so parallel requests cannot pass the row limit, share a position or leave `rowCount` wrong. A request with any bad cell, unknown row id or too many rows changes nothing.
- Only **input** columns are writable. Cell errors are `UNKNOWN_COLUMN`, `NOT_AN_INPUT_COLUMN` (enrichment, AI, formula, action) and `INVALID_CELL_VALUE` (an object or list, text over 10,000 characters, a NUL character, or one column sent twice), with `details.errors` naming up to 100 of them (`row` is the index in the request).
- A value that does not fit its column's `config.dataType` (`text` by default; `number`, `email`, `url`, `linkedin_url`, `domain`, `phone`, `date`, `checkbox`) is **stored and flagged**: `state: "error"`, `errorCode: "invalid_<type>"`. Numbers and checkbox words are converted, domains lower-cased.
- `null`, `""` or blank text clears a cell; an empty cell has no entry in `cells`. Writing a cell resets its confidence, credits, source and provenance.
- Deleting rows is permanent. Each delete request is written to the audit log as `workbook.rows.delete` (counts and up to 100 row ids, no values).
- `position` is a stable order key. New rows follow the highest position; deleting leaves gaps. Use `index` for the row's place in the current list.

### Reading, sorting, filtering, search
- `limit` is 1–500 (default 200); `offset` counts rows in the filtered, sorted list. Past the end returns `data: []` with the true `matched`. Continue with `nextOffset` while `hasMore`.
- `columnIds` limits the cells returned (not what is filtered, sorted or searched). A 200 × 20 window is about 785 KB, so a grid should ask for visible columns.
- All of it runs in the database over every row of the workbook. Each response comes from one snapshot, but rows added or deleted between two requests shift later offsets.
- `sort`: up to 3 of `{ columnId, direction }` or `{ field: "position" | "createdAt" | "source", direction }`. Empty cells are last in both directions; in a `number` column flagged text follows the numbers; text order follows the database collation; ties keep row order.
- `filters`: up to 10, all must match.
  - `{ type: "value", columnId, op, value }` with `equals`, `not_equals`, `contains`, `not_contains`, `starts_with` (text ignores case), `in` (up to 100 values), `gt`/`gte`/`lt`/`lte` (a number, or an ISO date compared as text, so `2026-01-01T09:00` is after `2026-01-01`), `is_empty`, `has_value` (no `value`).
  - `{ type: "state", columnId?, states }`: that column's cell state, or any cell of the row without `columnId`.
  - `{ type: "source", sources }`: the row's `source.type`.
- Empty means no cell, `null` or `""`, which includes queued, running and failed cells with no value. `not_equals` and `not_contains` include empty cells.
- `search` (up to 200 characters): substring, ignoring case, of any text, number or true/false cell value. Object and list values are not searched. `%` and `_` are ordinary characters.

Performance on 100,000 rows: [`workbooks-v2-rows-performance.md`](workbooks-v2-rows-performance.md).

