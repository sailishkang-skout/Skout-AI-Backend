import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { WorkbookV2Error, findLiveWorkbook } from "./workbook-v2.service.js";
import { SUPPRESSED_REASON, markRowSuppression } from "./workbook-suppression.service.js";

/**
 * Starting a column run or a CRM push (WB2-014). Only the checks exist: there is no execution engine yet (WB2-050),
 * so a permitted, well-formed request is answered "not implemented". Nothing is written, queued, sent or charged.
 * Whoever builds the engine replaces `notImplemented` and keeps the checks before it.
 *
 * **Suppressed rows (WB2-027, PRD SEC-8).** Every column type that runs (enrichment, AI, action, CRM push), every run
 * scope, retry and resumed job goes through both of these:
 * 1. `rowsThatMayRun` when choosing a chunk's rows, **before credits or AI actions are reserved**: suppressed rows are
 *    left out, counted as skipped.
 * 2. `runForRow` around **each** external operation (provider call, AI request, enrolment, list or CRM write, webhook
 *    send): it reads the opt-out records again, so someone who opted out since is not acted on.
 */
const { workbooks, workbookColumns, workbookRows } = schema;
const MAX_REPORTED_MISSING = 100;

/** Column types that are executed. Input columns hold typed data; formulas recompute by themselves, free (FX-2). */
const RUNNABLE_TYPES = new Set(["enrichment", "ai", "action"]);

export type RunKind = "run" | "crm_push";

/**
 * The column to be run, once it is known to belong to a live workbook of this workspace and to be runnable, and any
 * selected rows are known to be that workbook's. Owning the workbook says nothing about the ids sent with it.
 */
export async function findRunTarget(db: Db, workspaceId: string, workbookId: string, columnId: string, kind: RunKind, rowIds?: number[]) {
  await findLiveWorkbook(db, workspaceId, workbookId);
  const [column] = await db
    .select({ id: workbookColumns.id, type: workbookColumns.type, operation: workbookColumns.operation })
    .from(workbookColumns)
    .where(and(eq(workbookColumns.workbookId, workbookId), eq(workbookColumns.id, columnId)))
    .limit(1);
  if (!column) throw new WorkbookV2Error("NOT_FOUND", 404, "Column not found");
  if (kind === "crm_push" && !(column.type === "action" && column.operation === "push_to_crm")) {
    throw new WorkbookV2Error("COLUMN_NOT_RUNNABLE", 422, "Only a Push to CRM column can push to a CRM.", { columnId: column.id, type: column.type, operation: column.operation });
  }
  if (!RUNNABLE_TYPES.has(column.type)) {
    throw new WorkbookV2Error("COLUMN_NOT_RUNNABLE", 422, `${column.type} columns are not run.`, { columnId: column.id, type: column.type });
  }
  if (rowIds) await assertRowsBelong(db, workbookId, rowIds);
  return column;
}

/** A row of another workbook, whoever owns it, is as unknown as one that does not exist. */
async function assertRowsBelong(db: Db, workbookId: string, rowIds: number[]) {
  const wanted = [...new Set(rowIds)];
  const found = await db
    .select({ id: workbookRows.id })
    .from(workbookRows)
    .where(and(eq(workbookRows.workbookId, workbookId), inArray(workbookRows.id, wanted)));
  if (found.length === wanted.length) return;
  const have = new Set(found.map((r) => r.id));
  const missing = wanted.filter((id) => !have.has(id));
  throw new WorkbookV2Error("NOT_FOUND", 404, "Some rows were not found; nothing was started", {
    missingRowIds: missing.slice(0, MAX_REPORTED_MISSING),
    missingCount: missing.length,
  });
}

/** The rows of `rowIds` still in this workspace's live workbook. */
async function rowsPresent(db: Db, workspaceId: string, workbookId: string, rowIds: number[]): Promise<number[]> {
  const found = await db
    .select({ id: workbookRows.id })
    .from(workbookRows)
    .innerJoin(workbooks, eq(workbooks.id, workbookRows.workbookId))
    .where(and(eq(workbooks.workspaceId, workspaceId), isNull(workbooks.deletedAt), eq(workbookRows.workbookId, workbookId), inArray(workbookRows.id, rowIds)));
  return found.map((r) => r.id);
}

/**
 * Notes on each row's cell in the column that it was skipped as suppressed. A cell that holds a value keeps it, as it
 * is.
 */
async function recordSuppressedSkips(db: Db, workbookId: string, columnId: string, rowIds: number[]): Promise<void> {
  if (!rowIds.length) return;
  await db.execute(sql`
    INSERT INTO workbook_cells (workbook_id, row_id, column_id, state, error_code)
    SELECT r.workbook_id, r.id, ${columnId}::uuid, 'skipped', ${SUPPRESSED_REASON}
    FROM workbook_rows r
    WHERE r.workbook_id = ${workbookId}::uuid AND r.id IN (SELECT x::bigint FROM jsonb_array_elements_text(${JSON.stringify(rowIds)}::text::jsonb) AS x)
    ON CONFLICT (workbook_id, row_id, column_id) DO UPDATE SET state = 'skipped', error_code = ${SUPPRESSED_REASON}, updated_at = now()
    WHERE workbook_cells.value IS NULL`);
}

/**
 * Splits the rows a run chose into those it may work on and those it skips as suppressed, as the opt-out records stand
 * now. Rows that are no longer there are in neither.
 */
export async function rowsThatMayRun(db: Db, workspaceId: string, workbookId: string, columnId: string, rowIds: number[]): Promise<{ run: number[]; suppressed: number[] }> {
  if (!rowIds.length) return { run: [], suppressed: [] };
  const present = await rowsPresent(db, workspaceId, workbookId, rowIds);
  const out = await markRowSuppression(db, workspaceId, workbookId, present);
  const suppressed = present.filter((id) => out.has(id));
  await recordSuppressedSkips(db, workbookId, columnId, suppressed);
  return { run: present.filter((id) => !out.has(id)), suppressed };
}

export type RowRun<T> = { skipped: null; result: T } | { skipped: typeof SUPPRESSED_REASON | "row_missing" };

/**
 * Does one external operation for one row, unless the row's person has opted out or the row is gone (deleted, or
 * erased on request). The check is made here, immediately before `execute`.
 */
export async function runForRow<T>(db: Db, workspaceId: string, workbookId: string, columnId: string, rowId: number, execute: () => Promise<T>): Promise<RowRun<T>> {
  const { run, suppressed } = await rowsThatMayRun(db, workspaceId, workbookId, columnId, [rowId]);
  if (suppressed.length) return { skipped: SUPPRESSED_REASON };
  if (!run.length) return { skipped: "row_missing" };
  return { skipped: null, result: await execute() };
}

export function notImplemented(kind: RunKind): never {
  throw new WorkbookV2Error("NOT_IMPLEMENTED", 501, kind === "run" ? "Running columns is not available yet." : "Pushing to a CRM is not available yet.");
}
