# Workbooks V2 API: workbooks (WB2-011), rows (WB2-012), columns (WB2-013), permissions (WB2-014), activity (WB2-016), CSV import (WB2-020) and rows from Skout prospects (WB2-021), paste and type (WB2-022), CRM import (WB2-023)

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
           cells: { [columnId]: { value, state, confidence, creditsCharged, foundVia, verification, errorCode, updatedAt } } }
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
| `rows.added` | `source` (the rows' `source.type`; `duplicate` for a copy; `other` when one request names more than 20), `rows`, `rowCount`, `copiedFromWorkbookId?`. One event per source in a request. CRM imports add `object` and `viewName?`; Apollo imports also add `status`, `duplicates`, `skipped` and `failed` (see [Apollo import](#apollo-import)); Google Sheets imports add those and `spreadsheetName`, `tabName`, `pull` and `alreadyImported` (see [Google Sheets](#google-sheets)) |
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

## CSV import

Three steps: send the file, confirm how it maps, follow it. Nothing is added to the workbook before the confirm.

| Method and path | Permission | Body | Success | Errors besides 401/403 |
|---|---|---|---|---|
| `POST /:id/imports` | `enrichment:capture` | the file, with `Content-Type: text/csv` and `X-File-Name` (percent-encoded) | `201 { data: Import }` with `preview` | `404`, `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_FILE_TYPE`, `422 INVALID_CSV` / `TOO_MANY_ROWS`, `429 TOO_MANY_PENDING_IMPORTS` |
| `POST /:id/imports/:importId/confirm` | `enrichment:capture` | `{ columns, dedupe }` | `200` finished (up to 1,000 rows) or `202` queued | `404`, `409 IMPORT_STATE_CONFLICT`, `422 INVALID_IMPORT_MAPPING` / `ROW_LIMIT_EXCEEDED`, `503 IMPORT_UNAVAILABLE` |
| `GET /:id/imports` | `enrichment:read` | | `200 { data: Import[] }`, the latest 20, without previews | `404` |
| `GET /:id/imports/:importId` | `enrichment:read` | | `200 { data: Import }` | `404` |
| `DELETE /:id/imports/:importId` | `enrichment:capture` | | `200`, cancels one not yet confirmed | `404`, `409` |
| `GET /:id/imports/:importId/report` | `enrichment:read` | | the skipped-rows CSV | `404 NOT_FOUND` / `REPORT_NOT_AVAILABLE` |

```ts
Import = { id, workbookId, sourceType /* csv | list | smart_list | search | google_sheets | hubspot | apollo */, sourceName, truncated, status, fileName, fileBytes,
           counts: { total, processed, imported, duplicates, skipped, failed },
           progress /* 0-100, processed / total */, background, error: { code, message } | null,
           report: { available, rows },
           preview /* while awaiting_confirmation */: {
             delimiter, headers: [{ index, name, filled, fits /* types every value fits */ }],
             rows /* first 20 */: [{ line, values, problem? }],
             suggestions: [{ header, target: { columnId } | { newColumn: { name, dataType } } | null }] } | null,
           mapping /* once confirmed */, createdAt, confirmedAt, finishedAt }
status = awaiting_confirmation | queued | processing | completed | failed | cancelled
```

Confirm:
```json
{ "columns": [ { "header": 0, "columnId": "…" },
               { "header": 2, "newColumn": { "name": "Site", "dataType": "url" } } ],
  "dedupe": { "key": "email", "header": 0 } }
```
`header` is the position of a file column, from 0; columns not listed are not imported. `dedupe.key` is `email`, `linkedin_url`, `domain` or `none`. `dedupe.header` may be left out when exactly one mapped column has the key's type; a `text` column (or `url`, for LinkedIn and domain) can hold a key when named. A refused mapping changes nothing and lists every problem in `details.errors[{ path, code, message }]`: two file columns into one column, a non-input column, a new column whose name is taken, no usable key column, and so on.

### File rules
- `.csv`, up to 50 MB (52,428,800 bytes), 100,000 data rows and 500 columns. UTF-8, with or without a byte-order mark. The separator (comma, semicolon or tab) is read from the header line. The first line names the columns.
- The content is checked, whatever the sender calls it: Excel, PDF, compressed, binary, HTML and non-UTF-8 files are refused.
- A misplaced or unclosed quote refuses the whole file, naming the line, because the rows after it cannot be told apart reliably.
- Nothing in a file is evaluated. Blank lines are ignored (in a one-column file, that includes an empty value).

### What happens to each row
| Outcome | When | Counted as |
|---|---|---|
| Imported | Every mapped value fits its column's type | `imported` |
| Duplicate | Its key is already in the key column of the workbook, or in an earlier imported row of the file | `duplicates` |
| Invalid value | A mapped value does not fit its column (or is a key that cannot be compared) | `failed` |
| Malformed row | Wrong number of values (extra empty ones are ignored) | `failed` |
| Over the row limit | The workbook is full | `failed` |
| Skipped | Every mapped column is empty | `skipped` |

A row whose key is empty is imported. Keys ignore case and spacing; domains ignore scheme, `www.` and path; LinkedIn addresses ignore scheme, sub-domain, query and a trailing slash or language suffix. Existing rows are never changed. Imported rows have `source = { type: "csv", fileName, importId, importedAt }`.

Every row not imported is in the report: line in the file, result, reason and the original values. Values that a spreadsheet would run as a formula are prefixed with `'`. Reports are kept for 30 days (the exports bucket's lifecycle).

### Processing and storage
- Imports over 1,000 rows are queued on BullMQ (`skout-workbook-import`), run by a worker in the API process, 5 attempts with backoff. Each chunk of up to 1,000 rows is one transaction that adds rows, records issues and advances `processed`, so a retry resumes after the last whole chunk. The workbook is locked only for a chunk.
- A mapped column deleted or retyped, a deleted workbook or a missing file ends the import as `failed` without retrying. Rows already added stay.
- The uploaded file is stored in `EXPORTS_BUCKET` under `workbook-imports/` (a local `.workbook-imports/` folder outside production) and removed when the import completes, fails or is cancelled. A sweep every 5 minutes cancels imports not confirmed within 24 hours, re-queues ones with no progress for 10 minutes, fails them after 6 hours, and finishes any leftover cleanup. The bucket's 30-day expiry is the backstop.
- Production needs `EXPORTS_BUCKET` and Redis; without storage the routes answer `503`, without Redis large imports answer `503` and nothing changes.
- One `rows.added` activity entry (`source: "csv"`) is written when an import ends having added rows; new columns are recorded as `column.added`.
- At most 10 unfinished imports per workspace.

## Rows from Skout lists, smart lists and Search

| Method and path | Permission | Body | Success | Errors besides 401/403 |
|---|---|---|---|---|
| `GET /:id/sources/lists/:listId/prospects?page=&pageSize=` | `enrichment:read` | | `200 { source, data: Prospect[], total, page, pageSize }` | `404`, `422` |
| `GET /:id/sources/smart-lists/:smartListId/prospects?page=&pageSize=` | `enrichment:read` | | the same | `404`, `422 PAGE_OUT_OF_RANGE` (past 10,000), `503 SEARCH_UNAVAILABLE` |
| `POST /:id/prospect-imports` | `enrichment:capture` | `{ source, selection }`, optional `Idempotency-Key` | `200` finished (up to 1,000) or `202` queued, `{ data: Import }` | `404`, `422 UNKNOWN_SOURCE` / `NOTHING_TO_ADD` / `ROW_LIMIT_EXCEEDED`, `429`, `503 IMPORT_UNAVAILABLE` / `SEARCH_UNAVAILABLE` |

```ts
Prospect  = { prospectId, fullName, title, companyName, companyDomain, inWorkbook }   // no contact details
source    = { type: "list", listId } | { type: "smart_list", smartListId } | { type: "search" }
selection = { prospectIds: string[] /* 1 to 10,000 */ } | { all: true /* not for search */ }
```
`pageSize` is 1–100 (default 25). Progress, the list of imports and the skipped-rows report are the import routes above; an addition cannot be confirmed or cancelled.

### What is added
- Each row has `prospectId` and `source = { type, importId, addedAt, listId?, listName?, smartListId?, smartListName? }`. A prospect is in a workbook once (a unique index backs this); adding again counts as `duplicates`.
- A prospect must be one the workspace already holds, or one the shared search index has. One the index supplies is activated for the workspace, as adding it to a list does; one already held is not changed. Anything else, another workspace's own prospects included, is `skipped` as "Prospect not found".
- A list selection is checked against the list's members, and a chosen smart list selection against its filters. `all` fixes a list's members when the request is made, and reads a smart list's matches in the job. At most the workspace's row limit is considered (`truncated` says so); rows past the workbook's limit are `failed`.
- Columns: each fact goes into the first input column whose name means the same (for email and phone, a `find_email` or `find_phone` column first), otherwise a new input column, made only when somebody has that fact. Facts: full name, title, company, company domain, LinkedIn URL, email, phone. A value that does not fit its column is stored and flagged.

### Stored enrichment, free
Email and phone come only from what the workspace already holds (enrichment results, verification verdicts, dated CRM values), found or verified within **30 days**, and never an address verified invalid. A CRM value with no recorded date is left out unless recently verified. The search index's contact details are never copied. Those cells have `foundVia: "cache"` (shown as "From your Skout data"), `creditsCharged: 0`, and for email `verification` (`valid`, `catch_all`, `risky`, `unknown`, `unverified`). The supplying provider is kept in server-only provenance. No provider is called and nothing is charged. Editing the cell clears the label.

### Processing
Up to 1,000 run during the request; more are queued on the import queue and processed in chunks of 500, each one transaction, resuming after the last whole chunk. Without a search index in production, Search and smart list additions answer `503`; list additions use the workspace's own records.

## Paste and type

Typing a new row uses `POST /:id/rows` (its source is `manual`); editing a cell uses `PATCH /:id/rows/:rowId`. A paste
is one request.

| Method and path | Permission | Idempotency |
| --- | --- | --- |
| `POST /:id/paste` | `enrichment:capture` | `Idempotency-Key` accepted; send one so a retry adds nothing twice |

```json
{
  "columnIds": ["<column>", "<column>"],
  "values": [["ada@example.com", "example.com"], ["", "example.org"]],
  "start": { "rowId": 12, "endRowId": 15, "rows": 4 }
}
```

- `columnIds` are the destination columns, left to right (1 to 200, each once). `values` holds one string per column
  for every row: at most 10,000 rows and 100,000 cells (body limit 10 MB).
- `start` names the existing rows under the top of the block, in position order: how many, the first and the last. Leave
  it out and every row is new. If those rows are no longer what it says, nothing is pasted (`409 ROWS_CHANGED`).
- Existing rows are overwritten; an empty value clears its cell. An overwritten cell loses its `foundVia` and
  `verification`. Cells outside the block are not touched.
- Rows of the block past those become new rows with source `{ "type": "paste" }`. A row with nothing in it is not
  created. The activity log records `rows.added` with source `paste`; changes to existing cells are not logged.
- Values for a column that is not an input column are left out and counted. An unknown column refuses the paste
  (`422 UNKNOWN_COLUMN`).
- A value that does not fit its column's type is kept and flagged. If more than half the values pasted into a typed
  column do not fit it, nothing is pasted: `422 INCOMPATIBLE_COLUMN`, with
  `details.columns[]` of `{ columnId, dataType, values, invalid, looksLike }`.
- A value a cell cannot hold (over 10,000 characters, or containing NUL) is not stored; the cell keeps what it had.
- Past the row limit nothing is pasted (`422 ROW_LIMIT_EXCEEDED`).
- The paste is one transaction. It starts no enrichment, AI, formula or action work.
- Rows are not deduplicated (only imports are).

The answer:

```json
{
  "data": {
    "added": 1, "updated": 4, "cellsWritten": 8, "cellsCleared": 1, "rowCount": 120, "blankRows": 0,
    "invalid": { "count": 1, "cells": [{ "row": 2, "columnId": "<column>", "errorCode": "invalid_email" }] },
    "rejected": { "count": 0, "cells": [] },
    "skippedColumns": [{ "columnId": "<column>", "values": 3 }]
  }
}
```

`row` counts from the top of the block, from 0; each list holds the first 100.

## CRM import

Contacts and companies from the workspace's own CRM connection. **Only HubSpot can be imported from**: Salesforce and
Pipedrive have no connector in Skout, and are reported as `not_available`.

| Method and path (`/api/v1/workbooks-v2`) | Permission |
| --- | --- |
| `GET /:id/crm-sources` | `enrichment:capture` |
| `GET /:id/crm-sources/:provider/:object` (`contact` or `company`) | `enrichment:capture` |
| `POST /:id/crm-imports` (accepts `Idempotency-Key`) | `enrichment:capture` |

All three also need the workspace's CRM feature. The connection is always the session workspace's own; no request names
one, and no response carries a token.

1. `crm-sources` lists each CRM with `status`: `connected`, `needs_reauth`, `not_connected`, `not_configured` (no
   HubSpot app on this server) or `not_available`, and the objects it offers. Connecting is the existing flow
   (`POST /crm/hubspot/connect`).
2. `crm-sources/:provider/:object` answers the fields (`name`, `label`, `type`, `operators`), `defaultFields`, the
   saved selections (`views`: for HubSpot, its lists; `available: false` with a `reason` when they can't be read) and
   `filters.max`. HubSpot's saved views have no API, so they are not offered.
3. `crm-imports` reads the first 20 records and returns an import `awaiting_confirmation` with the same `preview` as a
   CSV upload. Nothing is added yet.

```json
{ "provider": "hubspot", "object": "contact", "fields": ["firstname", "email"],
  "filters": [{ "field": "lifecyclestage", "operator": "equals", "value": "lead" }] }
```

Send 1 to 50 `fields`, and either `viewId` or `filters` (all must match; at most 5), or neither for every record.
Operators: `equals`, `not_equals`, `contains`, `not_contains`, `greater_than`, `at_least`, `less_than`, `at_most`,
`has_value`, `is_empty`, limited per field type. A date given for a date-and-time field covers the whole day (UTC).

4. Confirm, follow, cancel and download the report with the import routes above (`/imports/:importId…`). The mapping and
   deduplication key work as for CSV. A field may only go into a column type listed in its header's `fits`
   (`422 INVALID_IMPORT_MAPPING` with `INCOMPATIBLE_FIELD`).

An import's `sourceType` is the provider, `crm` is `{ provider, object }` and `sourceName` the list's name. More than
1,000 records, or a count the CRM won't give, run in the background.

### What is stored

Each row has `source` `{ type: "hubspot", object, importId, importedAt, viewId?, viewName?, filtered? }` and

```json
{ "crmRef": { "provider": "hubspot", "object": "contact", "id": "1001", "accountId": "1234567" } }
```

`accountId` is the HubSpot portal. A write-back must check it against the connected portal before using `id`, which
means nothing in another account. A workbook holds each `(provider, accountId, object, id)` once (unique index), so
importing again adds only new records. Records are not updated by a later import.

### Processing

Records are read 100 at a time and added in chunks of 500, each chunk saving where to read next. Rows already added stay
when an import stops. A rate limit or an unreachable CRM is retried later (a small import moves to the background); the
sweep gives up after six hours. When the workbook fills up, the import completes, lists what did not fit in the chunk it
reached, sets `truncated` and reads no further. Nothing runs on new rows, and nothing is written to the CRM.

| Code | Meaning |
| --- | --- |
| `CRM_NOT_AVAILABLE` (422, or 403 without the CRM feature) | No connector, or CRM not in the plan |
| `CRM_NOT_CONNECTED`, `CRM_RECONNECT_REQUIRED`, `CRM_SCOPE_MISSING` (409) | Connect, reconnect, or grant access |
| `CRM_ACCOUNT_CHANGED` (409) | A different account is connected than the preview read |
| `CRM_UNKNOWN_FIELD`, `CRM_UNKNOWN_VIEW`, `CRM_INVALID_FILTER`, `CRM_QUERY_REJECTED` (422) | The selection can't be used |
| `CRM_RATE_LIMITED` (429), `CRM_UNAVAILABLE` (502) | Try again later |
| `NOTHING_TO_ADD` (422) | The selection is empty |

An import that fails after confirmation carries the same codes, plus `CRM_VIEW_NOT_FOUND`, in `error`.

### Before using it

Companies need two more HubSpot permissions. Add `crm.objects.companies.read` and `crm.schemas.companies.read` to the
HubSpot app as **optional** scopes, then set `HUBSPOT_COMPANY_SCOPES=true`, then reconnect. Setting the variable before
the app lists the scopes can stop people connecting HubSpot at all.

## Apollo import

People saved as contacts in the workspace's own Apollo account: one of its contact lists, or a search of its saved
contacts. **Apollo's search of its whole people database is not offered.** It returns no email addresses, LinkedIn URLs
or domains, and getting them spends Apollo credits. Apollo's saved searches have no API.

| Method and path (`/api/v1/workbooks-v2`) | Permission |
| --- | --- |
| `GET /:id/apollo-source` | `enrichment:capture` |
| `POST /:id/apollo-imports` (accepts `Idempotency-Key`) | `enrichment:capture` |

The connection is the workspace's Apollo API key saved in Settings → Integrations (`PUT /integrations/apollo`), one per
workspace. No request names a connection and no response carries a key. The CRM feature is not needed.

1. `apollo-source` answers `connection.status` (`connected`, `needs_reauth` when the stored key can't be read, or
   `not_connected`), the `fields` (`name`, `label`), `defaultFields`, `maxRecords` and, when connected, `lists` and
   `stages`, each `{ available, reason, items }`. A key without access to one of them still imports by the other, or by
   keywords.
2. `apollo-imports` reads the first 20 contacts and returns an import `awaiting_confirmation`. Nothing is added yet.

```json
{ "fields": ["name", "email", "company_domain"], "search": { "keywords": "engineer", "stageIds": ["…"] } }
```

Send 1 to 50 `fields` and exactly one of `listId` or `search`. An empty `search` selects every saved contact.

| Field | Column type offered |
| --- | --- |
| `name`, `first_name`, `last_name`, `email_status`, `title`, `headline`, `company`, `location`, `city`, `state`, `country` | text |
| `email` | email |
| `company_domain` | domain |
| `company_website` | web address |
| `linkedin_url` | LinkedIn URL |
| `phone` | phone number |

Text is always allowed. A value Apollo doesn't hold leaves the cell empty. `company_domain` comes from the contact's
organisation or account, or its website. `location` is city, state and country, or else Apollo's raw address.

3. Confirm, follow, cancel and download the report with the import routes (`/imports/:importId…`), as for
   [CRM import](#crm-import): the mapping, deduplication keys, background running over 1,000 records, retries and row
   limit are the same.

An import's `sourceType` is `apollo`, `sourceName` the list's name and `crm` null.

### What is stored

Each row has `source` `{ type: "apollo", object: "contact", importId, importedAt, viewId?, viewName?, searchKeywords?,
searchStages? }` and

```json
{ "crmRef": { "provider": "apollo", "object": "contact", "id": "<Apollo contact id>", "personId": "<Apollo person id>" } }
```

A workbook holds each Apollo contact once, whichever selection or saved key brought it. A later import adds only new
contacts and changes none. Nothing runs on new rows and nothing is written to Apollo.

The `rows.added` activity entry is written when a confirmed import ends, completed or failed, even if it added nothing.
It never holds the words searched for, which can be someone's name or address.

### Reading Apollo

Contacts are read 100 at a time, oldest first, and at most 50,000 of them (Apollo's limit): `truncated.reason` is then
`source_limit`. A background import waits out a rate limit of up to a minute, three times per page, and otherwise is
retried later. Contacts deleted in Apollo while an import reads can shift its pages and be missed; importing again adds
them.

| Code | Meaning |
| --- | --- |
| `APOLLO_NOT_CONNECTED`, `APOLLO_RECONNECT_REQUIRED` (409) | No key saved, or Apollo rejects it |
| `APOLLO_SCOPE_MISSING` (409) | The key or plan may not read this |
| `APOLLO_CONNECTION_CHANGED` (409) | A key was saved again since the preview |
| `APOLLO_UNKNOWN_FIELD`, `APOLLO_UNKNOWN_LIST`, `APOLLO_UNKNOWN_STAGE`, `APOLLO_SEARCH_REJECTED` (422) | The selection can't be used |
| `APOLLO_RATE_LIMITED` (429), `APOLLO_UNAVAILABLE` (502) | Try again later |
| `NOTHING_TO_ADD` (422) | The selection is empty |

The key needs Apollo API access to contact search, plus lists and contact stages to offer those, or a master key.

## Google Sheets

Rows from one tab of a Google spreadsheet, imported once and then topped up when someone asks. Nothing syncs on its own
and nothing is written to Google.

### Connecting

Each member connects their **own** Google account within a workspace. The only permission asked for is
`https://www.googleapis.com/auth/spreadsheets.readonly`. Google offers no permission that is both read-only and limited
to chosen files, so this one can read any spreadsheet the person can; Skout reads only the one whose link they paste.
Skout asks for no Drive access, so it can't list files.

| Method and path (`/api/v1`) | Answer |
| --- | --- |
| `GET /google-sheets/connection` | `{ configured, status: "connected" \| "needs_reauth" \| "not_connected", connectedAt }` |
| `POST /google-sheets/connection/start` | `{ authorizationUrl }` |
| `POST /google-sheets/connection` with `{ code, state }` | The connection |
| `DELETE /google-sheets/connection` | `{ disconnected, revokedAtGoogle }` |

Any signed-in member may use them, for themselves only. Google returns the browser to the app's
`/settings/google-sheets` page, which sends `code` and `state` back as the signed-in person. A `state` works once, for
ten minutes, and only for the member and workspace that started, so nobody's consent can be attached to another's
account. Errors: `google_sheets_not_configured` (503), `invalid_oauth_state`, `google_permission_not_granted`,
`google_sign_in_failed` (400) and `google_unavailable` (502).

Tokens are stored encrypted with `INTEGRATION_ENCRYPTION_KEY` (the rotation script covers them) and are never returned.
Disconnecting deletes them, cancels that person's unconfirmed sheet previews, stops their running sheet imports, and
revokes the grant at Google (`revokedAtGoogle: false` if Google didn't confirm). Rows stay.

### Importing a tab

| Method and path (`/api/v1/workbooks-v2`) | Permission |
| --- | --- |
| `GET /:id/sheet-sources` | `enrichment:read` |
| `POST /:id/sheets/inspect` with `{ spreadsheet }` | `enrichment:capture` |
| `POST /:id/sheets-imports` with `{ spreadsheet, sheetId }` (accepts `Idempotency-Key`) | `enrichment:capture` |
| `POST /:id/sheet-sources/:sourceId/pull` with `{}` (accepts `Idempotency-Key`) | `enrichment:capture` |
| `DELETE /:id/sheet-sources/:sourceId` | `enrichment:capture` |

1. `sheets/inspect` takes a Google Sheets link or id and answers `{ spreadsheetId, name, linkedSheetId, tabs: [{
   sheetId, name, rows, columns, sourceId }] }`. `rows` and `columns` are the grid's size.
2. `sheets-imports` copies the tab and returns an import `awaiting_confirmation` with the usual `preview`, plus
   `preview.sheet` `{ spreadsheetName, tabName, unique, source }`. Row 1 names the columns (an empty or repeated name is
   completed with the column's letter). Empty rows are ignored. Up to 100,000 rows, 500 columns and 50 MB. **What was
   previewed is what is imported**, however the sheet changes before the confirm. Only the person who asked sees the
   preview (`preview` is null for others).
3. Confirm with `POST /:id/imports/:importId/confirm`, as for CSV, adding `idColumn` (a heading's position, or null).
   Only the person who previewed may confirm, through the same connection. Over 1,000 rows run in the background.

An import's `sourceType` is `google_sheets`, `sourceName` the tab, and `sheet` `{ sourceId, spreadsheetName, tabName,
pull }`. The report's first column is the row number in the sheet.

### Recognising rows

Sheets gives rows no lasting id, and a read-only app can't set one. So each tab imported into a workbook becomes a
**source** that remembers, by identity, every row it has added:

- **With an ID column** (`idColumn`): the value in that column. Edits to other columns don't add the row again. A row
  with nothing there is skipped; a value used twice adds only its first row.
- **Without one**: what the row holds in the columns of the first import. Moving rows, adding columns and editing other
  columns don't matter, but **a row edited in those columns comes in again as a new row**. Identical rows are counted, so
  each is added once.

A later import of the same tab must recognise rows the same way (`409 SHEET_IDENTITY_CHANGED`). Forgetting the source
(`DELETE`) removes what it remembers, so its rows can then be added again.

### Pull new rows

Reads the tab again through the connection of **whoever asks**, who must be able to open it, and adds only rows the
source has not added. Existing rows are never changed or removed. A row skipped as a duplicate or as invalid was not
added, so a later pull looks at it again; a row deleted from the workbook is not added back. Columns follow their
headings, so they may be moved in the sheet. The answer is `{ data: Import, alreadyRunning }`: while a pull of a tab is
under way, asking again returns it. `counts.alreadyImported` says how many rows were already added. Tabs that held more
than 1,000 rows are pulled in the background, as is one found to have grown past that.

A workbook copied with its rows keeps its sources.

| Code | Meaning |
| --- | --- |
| `SHEETS_NOT_CONFIGURED` (503) | No Google app on this server |
| `SHEETS_NOT_CONNECTED`, `SHEETS_RECONNECT_REQUIRED`, `SHEETS_SCOPE_MISSING` (409) | Connect or reconnect |
| `SHEETS_CONNECTION_CHANGED` (409), `SHEETS_NOT_YOURS` (403) | The preview was made with another connection, or by someone else |
| `SHEETS_INVALID_LINK`, `SHEETS_NO_ACCESS`, `SHEETS_SPREADSHEET_NOT_FOUND`, `SHEETS_TAB_NOT_FOUND`, `SHEETS_REJECTED`, `SHEET_INVALID`, `NOTHING_TO_ADD` (422) | The sheet can't be used |
| `SHEET_IDENTITY_CHANGED`, `SHEET_IMPORT_RUNNING`, `SHEET_MAPPING_CHANGED` (409) | The source can't take this now |
| `SHEETS_RATE_LIMITED` (429), `SHEETS_UNAVAILABLE` (502) | Try again later |

An import that fails after starting carries these in `error`, plus `SHEETS_DISCONNECTED`, `SHEET_HEADING_MISSING` and
`MAPPING_CHANGED`. Reads are retried with growing waits; a background pull that still can't read Google is tried again
later and given up after six hours.

### Before using it

1. Create a Google Cloud project **used only for this**, enable the Google Sheets API, and add the consent screen with
   the `spreadsheets.readonly` scope. Google classes it as sensitive: people outside your organisation need the app
   verified by Google.
2. Create a web OAuth client with the redirect `<app URL>/app/settings/google-sheets`.
3. Set `GOOGLE_SHEETS_CLIENT_ID` and `GOOGLE_SHEETS_CLIENT_SECRET`.

A separate project matters: revoking at Google removes everything the person granted that project, so sharing the
Calendar and mailbox app would disconnect those too.
