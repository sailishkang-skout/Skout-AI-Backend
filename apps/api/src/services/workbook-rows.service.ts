import { and, count, eq, inArray, max, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { WorkbookV2Error, findLiveWorkbook, getWorkspaceRowLimit, lockLiveWorkbook, type WorkbookActor } from "./workbook-v2.service.js";
import { inputDataType, normalizeInputValue, type NormalizedCell } from "./workbook-cell-values.js";
import { recordWorkbookActivity } from "./workbook-activity-log.js";
import { queryRowIds, type RowQuery } from "./workbook-rows.query.js";
import { markRowSuppression } from "./workbook-suppression.service.js";

/**
 * Workbook rows (WB2-012). A row belongs to one workbook; each value is a row in `workbook_cells`, and an empty cell
 * has no record. Positions are a stable order key: new rows go after the last one, and deleting rows leaves gaps
 * (nothing is renumbered), so a window is addressed by its offset in the ordered, filtered list.
 *
 * Every function takes the workspace from the session and goes through that workspace's workbook first, and every
 * statement on rows or cells filters by workbook id (tenant isolation, and one partition for the cells).
 */
const { workbooks, workbookColumns, workbookRows, workbookCells, publicWorkbookCellColumns } = schema;

export const MAX_ROWS_PER_REQUEST = 1_000;
export const MAX_ROWS_PER_DELETE = 10_000;
const CELL_INSERT_CHUNK = 4_000;
const MAX_REPORTED_ERRORS = 100;
/** A request naming more kinds of source than this has the smallest ones counted together. */
const MAX_SOURCES_PER_REQUEST = 20;

export interface NewRow {
  cells?: Record<string, unknown>;
  source?: Record<string, unknown> & { type: string };
  crmRef?: { provider: string; id: string };
}

export interface CellDto {
  value: unknown;
  state: string;
  confidence: number | null;
  creditsCharged: number;
  foundVia: string | null;
  verification: string | null;
  errorCode: string | null;
  updatedAt: string;
}

export interface RowDto {
  id: number;
  position: number;
  source: Record<string, unknown>;
  prospectId: string | null;
  crmRef: Record<string, unknown> | null;
  suppressed: boolean;
  createdAt: string;
  /** Keyed by column id. A column with no entry is empty. */
  cells: Record<string, CellDto>;
}

export interface RowWindow {
  data: Array<RowDto & { index: number }>;
  window: {
    /** Place of the first returned row in the ordered, filtered list. */
    offset: number;
    limit: number;
    returned: number;
    /** Rows that match the filters and search. */
    matched: number;
    /** All rows in the workbook. */
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
}

interface Column {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

export async function columnsOf(db: Db, workbookId: string): Promise<Map<string, Column>> {
  const rows = await db
    .select({ id: workbookColumns.id, type: workbookColumns.type, config: workbookColumns.config })
    .from(workbookColumns)
    .where(eq(workbookColumns.workbookId, workbookId));
  return new Map(rows.map((c) => [c.id, c]));
}

export async function countRows(db: Db, workbookId: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(workbookRows).where(eq(workbookRows.workbookId, workbookId));
  return r?.n ?? 0;
}

/** Rows (in the order of `ids`) with their cells, never including server-only provenance. */
async function loadRows(db: Db, workbookId: string, ids: number[], columnIds?: string[]): Promise<RowDto[]> {
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(workbookRows)
    .where(and(eq(workbookRows.workbookId, workbookId), inArray(workbookRows.id, ids)));
  const wantsCells = columnIds === undefined || columnIds.length > 0;
  const cells = wantsCells
    ? await db
        .select(publicWorkbookCellColumns)
        .from(workbookCells)
        .where(and(eq(workbookCells.workbookId, workbookId), inArray(workbookCells.rowId, ids), columnIds ? inArray(workbookCells.columnId, columnIds) : undefined))
    : [];
  const byRow = new Map<number, Record<string, CellDto>>();
  for (const c of cells) {
    let entry = byRow.get(c.rowId);
    if (!entry) byRow.set(c.rowId, (entry = {}));
    entry[c.columnId] = {
      value: c.value,
      state: c.state,
      confidence: c.confidence,
      creditsCharged: c.creditsCharged,
      foundVia: c.foundVia,
      verification: c.verification,
      errorCode: c.errorCode,
      updatedAt: c.updatedAt.toISOString(),
    };
  }
  const found = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = found.get(id);
    if (!r) return [];
    return [{ id: r.id, position: r.position, source: r.source, prospectId: r.prospectId, crmRef: r.crmRef, suppressed: r.suppressed, createdAt: r.createdAt.toISOString(), cells: byRow.get(r.id) ?? {} }];
  });
}

type CellProblem = { row?: number; columnId: string; code: "UNKNOWN_COLUMN" | "NOT_AN_INPUT_COLUMN" | "INVALID_CELL_VALUE"; message: string };

/** Checks each cell belongs to an input column of this workbook and holds something a cell can hold. */
function checkCells(cells: Record<string, unknown>, columns: Map<string, Column>, row: number | undefined, problems: CellProblem[]) {
  const out: Array<{ columnId: string; cell: NormalizedCell }> = [];
  const seen = new Set<string>();
  for (const [columnId, raw] of Object.entries(cells)) {
    const column = columns.get(columnId.toLowerCase());
    const where = row === undefined ? { columnId } : { row, columnId };
    if (!column) problems.push({ ...where, code: "UNKNOWN_COLUMN", message: "This workbook has no such column" });
    else if (column.type !== "input") problems.push({ ...where, code: "NOT_AN_INPUT_COLUMN", message: `Cells of ${column.type} columns cannot be edited` });
    // Ids that differ only in letter case name the same cell.
    else if (seen.has(column.id)) problems.push({ ...where, code: "INVALID_CELL_VALUE", message: "The same column was sent twice" });
    else {
      seen.add(column.id);
      const cell = normalizeInputValue(raw, inputDataType(column.config));
      if (cell.kind === "rejected") problems.push({ ...where, code: "INVALID_CELL_VALUE", message: cell.reason });
      else out.push({ columnId: column.id, cell });
    }
  }
  return out;
}

function failIfProblems(problems: CellProblem[]) {
  if (!problems.length) return;
  const first = problems[0]!;
  throw new WorkbookV2Error(first.code, 422, first.message, { errors: problems.slice(0, MAX_REPORTED_ERRORS), errorCount: problems.length });
}

/** The stored form of a typed value. A value that does not fit its column's type is kept and flagged. */
export function cellRecord(workbookId: string, rowId: number, columnId: string, cell: Extract<NormalizedCell, { kind: "value" }>) {
  return {
    workbookId,
    rowId,
    columnId,
    value: cell.value,
    state: (cell.errorCode ? "error" : "found") as "error" | "found",
    errorCode: cell.errorCode,
    confidence: null,
    creditsCharged: 0,
    foundVia: null,
    verification: null,
    internalProvenance: null,
  };
}

export async function touchWorkbook(tx: Db, workbookId: string, rowCount?: number) {
  await tx
    .update(workbooks)
    .set({ updatedAt: sql`now()`, ...(rowCount === undefined ? {} : { rowCount }) })
    .where(eq(workbooks.id, workbookId));
}

export interface AddedRows {
  added: number;
  rowCount: number;
  /** In the order they were sent. */
  rows: Array<{ id: number; position: number }>;
  /** Values stored but flagged because they do not fit their column's type. */
  invalidCells: Array<{ rowId: number; columnId: string; errorCode: string }>;
}

/** How many of the rows came from each source (PRD WB-5: "rows added (source, count)"), largest first. */
export function rowsBySource(rows: NewRow[]): Array<{ source: string; rows: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const source = row.source?.type ?? "manual";
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  const all = [...counts].map(([source, count]) => ({ source, rows: count })).sort((a, b) => b.rows - a.rows);
  if (all.length <= MAX_SOURCES_PER_REQUEST) return all;
  const kept = all.slice(0, MAX_SOURCES_PER_REQUEST - 1);
  return [...kept, { source: "other", rows: rows.length - kept.reduce((sum, s) => sum + s.rows, 0) }];
}

/** Rows by id, in that order. The caller must already have checked the workbook belongs to the workspace. */
export const getRows = (db: Db, workbookId: string, ids: number[]) => loadRows(db, workbookId, ids);

/**
 * Appends rows with their input values. All or nothing: any bad cell, an unknown column or the row limit refuses the
 * whole request, so a retry never has half a batch to reconcile.
 */
export async function addRows(
  db: Db,
  actor: WorkbookActor,
  workbookId: string,
  input: NewRow[],
  /** More counts for the activity entry, such as what a webhook request left out (WB2-026). */
  counts: Record<string, number> = {}
): Promise<AddedRows> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await lockLiveWorkbook(tx, actor.workspaceId, workbookId);
    const columns = await columnsOf(tx, workbookId);
    const problems: CellProblem[] = [];
    const checked = input.map((row, i) => checkCells(row.cells ?? {}, columns, i, problems));
    failIfProblems(problems);

    const limit = await getWorkspaceRowLimit(tx, actor.workspaceId);
    const existing = await countRows(tx, workbookId);
    if (existing + input.length > limit) {
      throw new WorkbookV2Error(
        "ROW_LIMIT_EXCEEDED",
        422,
        `This workspace allows ${limit.toLocaleString("en-US")} rows per workbook; the workbook has ${existing.toLocaleString("en-US")} and ${input.length.toLocaleString("en-US")} more were sent.`,
        { limit, rows: existing, adding: input.length }
      );
    }

    const [last] = await tx.select({ position: max(workbookRows.position) }).from(workbookRows).where(eq(workbookRows.workbookId, workbookId));
    const first = (last?.position ?? -1) + 1;
    const inserted = await tx
      .insert(workbookRows)
      .values(input.map((row, i) => ({ workbookId, position: first + i, source: row.source ?? { type: "manual" }, crmRef: row.crmRef ?? null })))
      .returning({ id: workbookRows.id, position: workbookRows.position });
    // Matched by position, which is unique within this batch; the order of RETURNING is not relied on.
    const idAt = new Map(inserted.map((r) => [r.position, r.id]));
    const cells = checked.flatMap((rowCells, i) =>
      rowCells.flatMap(({ columnId, cell }) => (cell.kind === "value" ? [cellRecord(workbookId, idAt.get(first + i)!, columnId, cell)] : []))
    );
    for (let i = 0; i < cells.length; i += CELL_INSERT_CHUNK) await tx.insert(workbookCells).values(cells.slice(i, i + CELL_INSERT_CHUNK));
    await markRowSuppression(tx, actor.workspaceId, workbookId, [...idAt.values()]);

    const rowCount = existing + input.length;
    await touchWorkbook(tx, workbookId, rowCount);
    for (const added of rowsBySource(input)) {
      await recordWorkbookActivity(tx, actor, workbookId, { action: "workbook.rows.added", after: { ...added, rowCount, ...counts } });
    }
    return {
      added: input.length,
      rowCount,
      rows: input.map((_, i) => ({ id: idAt.get(first + i)!, position: first + i })),
      invalidCells: cells.flatMap((c) => (c.errorCode ? [{ rowId: c.rowId, columnId: c.columnId, errorCode: c.errorCode }] : [])),
    };
  });
}

/** Sets or clears cells of input columns in one row. All or nothing. */
export async function updateRowCells(db: Db, actor: WorkbookActor, workbookId: string, rowId: number, input: Record<string, unknown>): Promise<RowDto> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await lockLiveWorkbook(tx, actor.workspaceId, workbookId);
    const [row] = await tx
      .select({ id: workbookRows.id })
      .from(workbookRows)
      .where(and(eq(workbookRows.workbookId, workbookId), eq(workbookRows.id, rowId)))
      .limit(1);
    if (!row) throw new WorkbookV2Error("NOT_FOUND", 404, "Row not found");

    const problems: CellProblem[] = [];
    const checked = checkCells(input, await columnsOf(tx, workbookId), undefined, problems);
    failIfProblems(problems);

    const cleared = checked.filter((c) => c.cell.kind === "empty").map((c) => c.columnId);
    if (cleared.length) {
      await tx.delete(workbookCells).where(and(eq(workbookCells.workbookId, workbookId), eq(workbookCells.rowId, rowId), inArray(workbookCells.columnId, cleared)));
    }
    for (const { columnId, cell } of checked) {
      if (cell.kind !== "value") continue;
      const { workbookId: _w, rowId: _r, columnId: _c, ...fields } = cellRecord(workbookId, rowId, columnId, cell);
      await tx
        .insert(workbookCells)
        .values({ workbookId, rowId, columnId, ...fields })
        .onConflictDoUpdate({ target: [workbookCells.workbookId, workbookCells.rowId, workbookCells.columnId], set: { ...fields, updatedAt: sql`now()` } });
    }
    // The row may now identify someone else.
    await markRowSuppression(tx, actor.workspaceId, workbookId, [rowId]);
    await touchWorkbook(tx, workbookId);
    return (await loadRows(tx, workbookId, [rowId]))[0]!;
  });
}

/**
 * Deletes rows and, through the foreign key, their cells. Permanent, so it is audited (ids only, never cell values).
 * All or nothing: an id that is not in this workbook refuses the request.
 */
export async function deleteRows(db: Db, actor: WorkbookActor, workbookId: string, ids: number[]): Promise<{ deleted: number; rowCount: number }> {
  const wanted = [...new Set(ids)];
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await lockLiveWorkbook(tx, actor.workspaceId, workbookId);
    const gone = await tx
      .delete(workbookRows)
      .where(and(eq(workbookRows.workbookId, workbookId), inArray(workbookRows.id, wanted)))
      .returning({ id: workbookRows.id });
    if (gone.length !== wanted.length) {
      const found = new Set(gone.map((r) => r.id));
      const missing = wanted.filter((id) => !found.has(id));
      throw new WorkbookV2Error("NOT_FOUND", 404, missing.length === 1 && wanted.length === 1 ? "Row not found" : "Some rows were not found; nothing was deleted", {
        missingRowIds: missing.slice(0, MAX_REPORTED_ERRORS),
        missingCount: missing.length,
      });
    }
    const rowCount = await countRows(tx, workbookId);
    await touchWorkbook(tx, workbookId, rowCount);
    await recordWorkbookActivity(tx, actor, workbookId, {
      action: "workbook.rows.delete",
      after: { deleted: gone.length, rowCount, rowIds: wanted.slice(0, MAX_REPORTED_ERRORS) },
    });
    return { deleted: gone.length, rowCount };
  });
}

/** A window of the workbook's rows after filtering, searching and sorting all of them in the database. */
export async function getRowWindow(db: Db, workspaceId: string, workbookId: string, query: RowQuery): Promise<RowWindow> {
  return db.transaction(
    async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await findLiveWorkbook(tx, workspaceId, workbookId);
      const columns = await columnsOf(tx, workbookId);
      const columnIds = query.columnIds?.map((id) => id.toLowerCase());
      const unknown = [...(columnIds ?? []), ...query.sort.flatMap((s) => ("columnId" in s ? [s.columnId] : [])), ...query.filters.flatMap((f) => ("columnId" in f && f.columnId ? [f.columnId] : []))].filter(
        (id) => !columns.has(id.toLowerCase())
      );
      if (unknown.length) throw new WorkbookV2Error("UNKNOWN_COLUMN", 422, "This workbook has no such column", { columnIds: [...new Set(unknown)] });

      const total = await countRows(tx, workbookId);
      const dataTypes = new Map([...columns.values()].map((c) => [c.id, c.type === "input" ? inputDataType(c.config) : undefined]));
      const { ids, matched } = await queryRowIds(tx, workbookId, query, dataTypes, total);
      const rows = await loadRows(tx, workbookId, ids, columnIds);
      const next = query.offset + rows.length;
      return {
        data: rows.map((r, i) => ({ ...r, index: query.offset + i })),
        window: { offset: query.offset, limit: query.limit, returned: rows.length, matched, total, hasMore: next < matched, nextOffset: next < matched ? next : null },
      };
    },
    // One snapshot, so the counts and the rows describe the same moment.
    { isolationLevel: "repeatable read", accessMode: "read only" }
  );
}
