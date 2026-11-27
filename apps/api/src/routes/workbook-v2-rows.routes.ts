import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { schema } from "@skout/db";
import { MAX_ROWS_PER_DELETE, MAX_ROWS_PER_REQUEST, addRows, deleteRows, getRowWindow, getRows, updateRowCells } from "../services/workbook-rows.service.js";
import { COMPARISON_OPERATORS } from "../services/workbook-rows.query.js";
import { MAX_PASTE_CELLS, MAX_PASTE_COLUMNS, MAX_PASTE_ROWS, pasteIntoWorkbook } from "../services/workbook-paste.service.js";
import { workbookRouteHelpers } from "./workbook-v2.common.js";

export const WINDOW_DEFAULT = 200;
export const WINDOW_MAX = 500;
/** A bulk request may carry 1,000 rows of text, more than the global 1 MB body limit allows. */
const BULK_BODY_LIMIT = 5 * 1024 * 1024;
/** The largest paste is 100,000 cells. */
const PASTE_BODY_LIMIT = 10 * 1024 * 1024;

/** Postgres text and jsonb cannot hold a NUL character; refuse it here rather than fail in the database. */
const text = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((v) => !v.includes("\u0000"), "must not contain a NUL character");
const slug = z.string().regex(/^[a-z][a-z0-9_]{0,49}$/, "lower-case letters, digits and underscores");
const uuid = z.string().uuid();
const rowId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const idParams = z.object({ id: uuid });
const rowParams = z.object({
  id: uuid,
  rowId: z
    .string()
    .regex(/^[1-9]\d{0,15}$/, "a row id")
    .transform(Number)
    .pipe(rowId),
});

/** What goes into each cell is checked against its column by the service. */
const cells = z.record(uuid, z.unknown()).refine((c) => Object.keys(c).length <= 200, "at most 200 cells per row");
const source = z
  .object({ type: slug })
  .catchall(z.union([text(500), z.number().finite(), z.boolean(), z.null()]))
  .refine((s) => Object.keys(s).length <= 20, "at most 20 source fields")
  .refine((s) => Object.keys(s).every((k) => k.length <= 100 && !k.includes("\u0000")), "invalid source field name");
// `.strict()`: position, prospectId, suppressed and ids are the server's to set.
const newRow = z.object({ cells: cells.optional(), source: source.optional(), crmRef: z.object({ provider: slug, id: text(200, 1) }).strict().optional() }).strict();
const bulkBody = z.object({ rows: z.array(newRow).min(1).max(MAX_ROWS_PER_REQUEST) }).strict();
const editBody = z.object({ cells: cells.refine((c) => Object.keys(c).length > 0, "send at least one cell") }).strict();
const deleteBody = z.object({ rowIds: z.array(rowId).min(1).max(MAX_ROWS_PER_DELETE) }).strict();
// What each value may hold is checked cell by cell by the service, so that one bad cell does not refuse the rest.
const pasteBody = z
  .object({
    columnIds: z
      .array(uuid)
      .min(1)
      .max(MAX_PASTE_COLUMNS)
      .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, "name each column once"),
    values: z.array(z.array(z.string()).min(1).max(MAX_PASTE_COLUMNS)).min(1).max(MAX_PASTE_ROWS),
    start: z.object({ rowId, endRowId: rowId, rows: z.number().int().min(1).max(MAX_PASTE_ROWS) }).strict().optional(),
  })
  .strict()
  .refine((b) => b.values.every((row) => row.length === b.columnIds.length), { path: ["values"], message: "every row needs one value per column" })
  .refine((b) => b.values.length * b.columnIds.length <= MAX_PASTE_CELLS, { path: ["values"], message: `at most ${MAX_PASTE_CELLS} cells in one paste` })
  .refine((b) => !b.start || b.start.rows <= b.values.length, { path: ["start", "rows"], message: "more existing rows than the paste has" });

const scalar = z.union([text(1_000), z.number().finite(), z.boolean()]);
const isoDate = text(40).refine((v) => /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v), "an ISO date");
const valueFilter = <O extends z.ZodTypeAny, V extends z.ZodTypeAny>(op: O, value: V) => z.object({ type: z.literal("value"), columnId: uuid, op, value }).strict();
const filter = z.union([
  valueFilter(z.enum(["equals", "not_equals"]), scalar),
  valueFilter(z.enum(["contains", "not_contains", "starts_with"]), text(1_000, 1)),
  valueFilter(z.literal("in"), z.array(scalar).min(1).max(100)),
  valueFilter(z.enum(COMPARISON_OPERATORS), z.union([z.number().finite(), isoDate])),
  z.object({ type: z.literal("value"), columnId: uuid, op: z.enum(["is_empty", "has_value"]) }).strict(),
  z.object({ type: z.literal("state"), columnId: uuid.optional(), states: z.array(z.enum(schema.WORKBOOK_CELL_STATES)).min(1).max(schema.WORKBOOK_CELL_STATES.length) }).strict(),
  z.object({ type: z.literal("source"), sources: z.array(slug).min(1).max(20) }).strict(),
]);
const direction = z.enum(["asc", "desc"]).default("asc");
const sortKey = z.union([z.object({ columnId: uuid, direction }).strict(), z.object({ field: z.enum(["position", "createdAt", "source"]), direction }).strict()]);
const offset = z.number().int().min(0).max(10_000_000);
const limit = z.number().int().min(1).max(WINDOW_MAX);
const columnIds = z.array(uuid).max(200);

const queryBody = z
  .object({
    offset: offset.default(0),
    limit: limit.default(WINDOW_DEFAULT),
    sort: z.array(sortKey).max(3).default([]),
    filters: z.array(filter).max(10).default([]),
    // A cleared search box sends an empty string: that means no search.
    search: text(200)
      .transform((s) => s.trim() || undefined)
      .optional(),
    columnIds: columnIds.optional(),
  })
  .strict();

const wholeNumber = z.string().regex(/^\d{1,9}$/, "a whole number").transform(Number);
// Strict: a `?sort=` or `?filter=` here would be silently ignored, so it is refused. Use POST .../rows/query.
const windowParams = z
  .object({
    offset: wholeNumber.pipe(offset).optional(),
    limit: wholeNumber.pipe(limit).optional(),
    columnIds: z
      .string()
      .transform((s) => (s === "" ? [] : s.split(",")))
      .pipe(columnIds)
      .optional(),
  })
  .strict();

/**
 * Workbook rows (WB2-012), registered beside the workbook routes and behind the same `workbooks_v2` switch,
 * which the access guard applies to everything under /api/v1/workbooks-v2.
 */
export async function workbookV2RowRoutes(app: FastifyInstance) {
  const { authorize, handle, handleOnce } = workbookRouteHelpers(app);

  app.get(
    "/workbooks-v2/:id/rows",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:read");
      const { id } = idParams.parse(request.params);
      const q = windowParams.parse(request.query ?? {});
      const body = await getRowWindow(db, actor.workspaceId, id, { offset: q.offset ?? 0, limit: q.limit ?? WINDOW_DEFAULT, sort: [], filters: [], columnIds: q.columnIds });
      return { status: 200, body };
    })
  );

  // A read: POST only because sorts and filters are structured.
  app.post(
    "/workbooks-v2/:id/rows/query",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:read");
      const { id } = idParams.parse(request.params);
      return { status: 200, body: await getRowWindow(db, actor.workspaceId, id, queryBody.parse(request.body ?? {})) };
    })
  );

  app.post(
    "/workbooks-v2/:id/rows",
    handleOnce(async (request, { db, actor }) => {
      const { id } = idParams.parse(request.params);
      const added = await addRows(db, actor, id, [newRow.parse(request.body ?? {})]);
      const [row] = await getRows(db, id, [added.rows[0]!.id]);
      return { status: 201, body: { data: row, rowCount: added.rowCount } };
    })
  );

  app.post(
    "/workbooks-v2/:id/rows/bulk",
    { bodyLimit: BULK_BODY_LIMIT },
    handleOnce(async (request, { db, actor }) => {
      const { id } = idParams.parse(request.params);
      const body = bulkBody.parse(request.body ?? {});
      return { status: 201, body: { data: await addRows(db, actor, id, body.rows) } };
    })
  );

  app.post(
    "/workbooks-v2/:id/paste",
    { bodyLimit: PASTE_BODY_LIMIT },
    handleOnce(async (request, { db, actor }) => {
      const { id } = idParams.parse(request.params);
      return { status: 200, body: { data: await pasteIntoWorkbook(db, actor, id, pasteBody.parse(request.body ?? {})) } };
    })
  );

  app.patch(
    "/workbooks-v2/:id/rows/:rowId",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id, rowId: row } = rowParams.parse(request.params);
      return { status: 200, body: { data: await updateRowCells(db, actor, id, row, editBody.parse(request.body ?? {}).cells) } };
    })
  );

  app.delete(
    "/workbooks-v2/:id/rows/:rowId",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id, rowId: row } = rowParams.parse(request.params);
      return { status: 200, body: { data: await deleteRows(db, actor, id, [row]) } };
    })
  );

  app.post(
    "/workbooks-v2/:id/rows/delete",
    handle(async (request) => {
      const { db, actor } = await authorize(request, "enrichment:capture");
      const { id } = idParams.parse(request.params);
      return { status: 200, body: { data: await deleteRows(db, actor, id, deleteBody.parse(request.body ?? {}).rowIds) } };
    })
  );
}
