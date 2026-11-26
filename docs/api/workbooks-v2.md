# Workbooks V2 API: workbooks (WB2-011), rows (WB2-012), columns (WB2-013), permissions (WB2-014) and activity (WB2-016)

Base path `/api/v1/workbooks-v2`.

**Access.** The workspace must have the `workbooks_v2` switch (`docs/ops/workbooks-v2-flag.md`), otherwise `403 feature_disabled`. The workspace always comes from the signed-in session; request bodies with unknown fields (including `workspaceId`, `rowLimit`, `rowCount`) are rejected.

| Permission | Allows | owner | admin | member |
|---|---|:-:|:-:|:-:|
| `enrichment:read` | View workbooks, rows and columns | yes | yes | yes |
| `enrichment:capture` | Create and edit: workbooks, rows, cells, columns (formulas included) | yes | yes | yes |
| `enrichment.run` | Run columns and push to a CRM (spends credits) | yes | yes | **no** |

A missing permission is `403` with `code: "FORBIDDEN"` and `details.requiredPermission`. `enrichment.run` stands alone: no other permission implies it, and it does not grant viewing or editing. The browser reads it from `GET /api/v1/me` → `permissions`.

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
`POST /`, `POST /:id/duplicate`, `POST /:id/rows`, `POST /:id/rows/bulk` and `POST /:id/columns` accept an optional `Idempotency-Key` (8–128 characters). A repeat with the same key and body returns the first answer; the same key with a different body is `IDEMPOTENCY_KEY_REUSED`; one still running is `409`. Without the header, each request creates a new workbook, rows or column.

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

## Columns

Columns are read with the workbook (`GET /:id`, in position order). Changing them needs `enrichment:capture`. Nothing here runs a column.

| Method and path | Body | Success | Errors besides 401/403/422 validation |
|---|---|---|---|
| `POST /:id/columns` | `{ name, type, operation?, config?, position?, width?, hidden?, frozen? }` | `201 { data: Column, columns }` | `404`, `422 INVALID_COLUMN_CONFIG`, `COLUMN_ORDER_INVALID`, `COLUMN_LIMIT_EXCEEDED` (200 columns) |
| `PATCH /:id/columns/:columnId` | at least one of `{ name, config, width, hidden, frozen }` | `200 { data: Column, columns }` | `404`, `422 INVALID_COLUMN_CONFIG`, `409 COLUMN_IN_USE` |
| `POST /:id/columns/reorder` | `{ columnIds, previousColumnIds? }` | `200 { data: Column[] }` | `404`, `409 COLUMN_ORDER_CONFLICT`, `422 COLUMN_ORDER_INVALID` |
| `DELETE /:id/columns/:columnId` | | `200 { data: { id }, columns }` | `404`, `409 COLUMN_IN_USE` |

`Column = { id, name, type, operation, config, position, width, hidden, frozen }`. `columns` is every column in order, since one change can move others.

### Behaviour
- Positions are always 0, 1, 2 … **Frozen columns are first**, because the grid pins a leading block. Freezing moves a column to the end of that block; unfreezing moves it to just after the block. Adding or reordering across the edge is `COLUMN_ORDER_INVALID`.
- `reorder` must list every column exactly once, otherwise `409` with the current order. Send `previousColumnIds` (the order the user started from) to also refuse overwriting someone else's reorder.
- `width` is a whole number from 60 to 1000 (default 160). Hiding keeps the column's place, settings and cells.
- `type` and `operation` cannot be changed. `config` is replaced as a whole and checked again.
- Changing an input column's `dataType` re-reads its cells: values that fit are converted, others are kept and flagged `invalid_<type>`.
- Deleting is permanent: it removes the column's cells and run history, removes it from saved views, and writes `workbook.column.delete` to the audit log. It is refused while any other column refers to it.
- An edit that would break a column reading this one, directly or through formulas, is `409 COLUMN_IN_USE` with `details.dependents`.
- Changes are one transaction each, holding the workbook's lock (row writes wait for them). On 100,000 rows, deleting a column took 1.5–2.5 s and changing a column's type 2.8–3.9 s (2 CPU database).
- A member without `enrichment:capture` sees only the host of a webhook column's `url`.

### References
A column is referred to as `{ "columnId" }`. Company data, LinkedIn profile and AI "fields" columns return several values, so add `"field"`: `{ "columnId", "field": "headcount" }`. Prompts embed `{{<columnId>}}` or `{{<columnId>.<field>}}`; anything else inside `{{ }}` is refused. A reference must be to another column of the same workbook, not an action column, without forming a circle, and of a readable kind (for example a number column cannot feed "Verify email"; text is accepted wherever a text-like value is read).

A **condition** ("Only run if") is `{ match: "all" | "any", rules: [1–10] }`, each rule `{ columnId, field?, op, value }` with `is_empty`, `has_value` (no value), `equals`, `not_equals`, `contains`, `not_contains`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`.

### `config` by type
Unknown keys are refused, so settings of one type never pass as another's.

**`input`** (no operation): `{ dataType }` — `text` (default), `number`, `email`, `url`, `linkedin_url`, `domain`, `phone`, `date`, `checkbox`.

**`enrichment`**: every operation takes `inputs`, and optionally `condition`, `maxCreditsPerRow` (0–1000) and `waterfall: { steps }` (default Skout data only). Steps are `{ source: "skout", enabled }` (exactly one) and `{ source: "own_key", provider, enabled }`; at least one is on, and the provider's key must be connected to the workspace.

| `operation` | `inputs` | Extra | Own-key providers |
|---|---|---|---|
| `find_email` | `linkedinUrl`, and/or `companyDomain` with (`fullName` or `firstName` + `lastName`) | `quality: { mustBeValid = true, acceptCatchAll = false }` | `hunter` |
| `verify_email` | `email` | | `hunter`, `millionverifier`, `zerobounce`, `neverbounce` |
| `find_phone` | as `find_email` | `quality: { phoneTypes: ["mobile","direct"] }` | `datagma`, `kaspr`, `lusha`, `contactout` |
| `company_data` | `companyDomain` and/or `companyName` | `fields`: `industry`, `headcount`, `location`, `revenueBand`, `linkedinUrl`, `description` (at least one) | `pdl` |
| `linkedin_profile` | `linkedinUrl`, or a name with `companyName` or `companyDomain` | `fields`: `title`, `seniority`, `location`, `currentCompany`, `startDate` (default all) | none |
| `company_domain` | `companyName` | | none |

**`ai`** (no operation): `{ prompt (1–8000), output, webResearch = false, template?, condition? }`. `output` is `{ type: "text" | "number" | "yes_no" }`, `{ type: "category", options: [2–50] }` or `{ type: "fields", fields: [{ name, type: "text"|"number"|"yes_no", description? }] }`. `template`: `first_line`, `icp_fit`, `summarise_company`, `classify_industry`, `tech_stack` (a label; the prompt is what is stored).

**`formula`** (no operation): `{ fn, … }`. Text in a formula is data; nothing is evaluated as code.

| `fn` | Settings |
|---|---|
| `extract_domain` | `source` |
| `split_name` | `source`, `part`: `first`\|`last` |
| `join` | `parts` (references and `{ text }`, at least one reference), `separator = " "` |
| `change_case` | `source`, `case`: `upper`\|`lower`\|`title`\|`sentence` |
| `trim_clean` | `source` |
| `find_replace` | `source`, `find`, `replace`, `matchCase = false` (plain text) |
| `if_then_else` | `condition`, `then`, `else` (a reference or `{ value }`) |
| `number_format` | `source`, `decimals = 2`, `thousandsSeparator = true`, `prefix`, `suffix` |
| `date_part` | `source`, `part`: `year`\|`quarter`\|`month`\|`day`\|`weekday` |
| `first_non_empty` | `sources` (2–20) |
| `regex_extract` | `source`, `pattern` (≤ 200), `ignoreCase = false`, `group = 0` |

**`action`**: each takes an optional `condition`.

| `operation` | Settings |
|---|---|
| `add_to_sequence` | `sequenceId` (this workspace's), `emailColumn` |
| `add_to_list` | `listId` (this workspace's) |
| `push_to_crm` | `provider`: `hubspot`\|`salesforce`\|`pipedrive` (connected), `object`: `contact`\|`company`, `mapping: [{ crmField, columnId, field? }]` |
| `send_to_webhook` | `url` (public HTTPS, no credentials), `columns: [reference]` |

Whatever runs these later must still enforce what saving cannot: webhook addresses after DNS resolution (SEC-6), a time limit on regular expressions (SEC-10), suppression (SEC-8), and that targets and keys still exist.

## Running and CRM push

| Method and path | Body | Permission |
|---|---|---|
| `POST /:id/runs` | `{ columnId, scope = "all", rowIds? }`; `scope`: `all`, `empty`, `failed`, `selected` (with 1–10,000 `rowIds`), `first10` | `enrichment.run` |
| `POST /:id/crm-push` | the same; `columnId` must be a `push_to_crm` action column | `enrichment.run` |

**There is no run engine yet.** A permitted, valid request answers `501 NOT_IMPLEMENTED`; nothing is written, queued, sent or charged. Other answers: `403` without the permission (checked before anything else), `404` for a workbook or column outside the workspace, or a selected row that is not in the workbook, `422 VALIDATION_FAILED`, `422 COLUMN_NOT_RUNNABLE` (input and formula columns are not run; `crm-push` on another column).

### For whoever builds the engine
- Keep `enrichment.run` and the checks in `findRunTarget` in front of it, and put any new route that executes or resumes a run behind the same permission. `workbook-v2-permissions.routes.test.ts` fails until each new V2 route is classified.
- A scheduled or background run must check the permission of whoever started it.
- Check the row and credit limits, and suppression.

### Giving a member the permission
Built-in roles: change the person's team role to admin (which also grants everything else an admin can do) and back again to remove it. Custom roles (`/cops/roles`) can carry `enrichment.run`, but in production those routes are open only to Skout's internal workspace, so **customer workspaces cannot grant it to a single member**.

## Activity

`GET /:id/activity?limit=&cursor=` returns what happened to one workbook, newest first. Needs `enrichment:read`.

```ts
200 { data: Event[], nextCursor: string | null }
Event = { id, type, occurredAt, actor: { id, name, email } | null, details }
```

`limit` is 1–100 (default 25). Pass `nextCursor` back as `cursor` until it is `null`. `422` for any other parameter or an altered cursor; `404` for a workbook that is unknown, deleted or another workspace's.

| `type` | `details` |
|---|---|
| `rows.added` | `source` (the rows' `source.type`; `duplicate` for a copy; `other` when one request names more than 20), `rows`, `rowCount`, `copiedFromWorkbookId?`. One event per source in a request |
| `rows.deleted` | `rows`, `rowCount` |
| `column.added` | `columnId`, `columnName`, `columnType`, `operation`, `copiedFromWorkbookId?` |
| `column.updated` | `columnId`, `columnName`, `renamedFrom?`, `settingsChanged?` (setting names), `dataType?: { from, to }` |
| `column.hidden` / `shown` / `frozen` / `unfrozen` | `columnId`, `columnName` |
| `column.resized` | `columnId`, `columnName`, `width: { from, to }` |
| `columns.reordered` | `columns: [{ columnId, columnName, from, to }]`, moved columns only |
| `column.deleted` | `columnId`, `columnName`, `columnType`, `operation` |
| `workbook.deleted` / `workbook.restored` | `name` / none (deleted workbooks show their log again once restored) |
| `run.started` | `runId`, `columnId`, `columnName`, `scope`, `rows`, `maxCredits`, `actualCredits: null` |
| `run.finished` | the same without `scope`, plus `status` (`completed`, `failed`, `cancelled`, `interrupted`) and `actualCredits` |
| `export` | `exportId`, `format`, `destination` (`download`, `email`), `status`, `rows` (`null` unless started or completed) |
| `crm_push` | `runId`, `columnId`, `columnName`, `provider`, `status`, `attempted`, `succeeded`, `failed`, `skipped` |

**Nothing emits `run.*`, `export` or `crm_push` yet**: Workbooks V2 has no run engine, export or CRM push.

### How it is stored
In the existing `audit_logs` table (`entity_type = "workbook"`), so the CustomerOps audit view shows the same entries. Each entry is written in the transaction that makes the change: a refused or failed request records nothing, and a change that cannot be recorded is not saved. A retried request with the same `Idempotency-Key` is recorded once; an edit or reorder that changes nothing is not recorded. Settings are named, never quoted, and cell values, row source details and addresses are never stored. Cell edits are not recorded. Entries written in one request may carry the same time.

### For the run, export and CRM push tickets
Call these from `services/workbook-activity.service.ts`. Each returns `{ recorded }` and records a step once.

| Call | When |
|---|---|
| `recordRunStarted(db, workspaceId, runId, { rows })` | A run is accepted; pass the accepting transaction as `db`. The maximum cost is the run's `max_credits`, the person its `started_by` |
| `recordRunFinished(db, workspaceId, runId, { status, attempt? })` | It stops. `failed` only when it will not be retried; `interrupted` with the job's attempt number when it may resume. The first final status stands |
| `recordCrmPush(db, workspaceId, runId, { status, attempt?, attempted, succeeded, failed, skipped })` | A Push to CRM run stops |
| `recordExport(db, actor, workbookId, { exportId, format, destination, status, rows? })` | An export starts, completes, fails or is cancelled |

**Billing requirement.** Every credit ledger entry a run creates must set `referenceId` to `workbookRunLedgerReference(workbookId, runId, rowId)`: `workbook:<workbookId>:run:<runId>[:row:<rowId>]`. `actualCredits` is the net of those entries and of entries that correct them (`compensates_id`), read from the ledger each time. A charge without that reference shows as costing nothing. The ledger has no index on `reference_id` or `compensates_id`, so this read grows with the workspace's ledger; the billing owner may want one.

