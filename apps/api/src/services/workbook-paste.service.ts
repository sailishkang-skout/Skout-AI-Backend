import { and, asc, eq, gte, inArray, max, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { WorkbookV2Error, getWorkspaceRowLimit, lockLiveWorkbook, type WorkbookActor } from "./workbook-v2.service.js";
import { inputDataType, looksLike, normalizeInputValue, type InputDataType, type NormalizedCell } from "./workbook-cell-values.js";
import { recordWorkbookActivity } from "./workbook-activity-log.js";
import { cellRecord, columnsOf, countRows, touchWorkbook } from "./workbook-rows.service.js";

/**
 * A pasted block (WB2-022, PRD ROW-3): rows of text laid over a workbook, starting at one of its rows and one of its
 * columns, the way a spreadsheet pastes.
 *
 *  - The block's columns go into `columnIds`, left to right. Values for a column that cannot be edited are left out
 *    and counted; nothing is ever moved into another column.
 *  - Rows that exist are overwritten in position order from `start`; an empty value clears its cell. Rows of the block
 *    beyond them become new rows.
 *  - A value that does not fit its column's type is kept and flagged, as when typed (PRD 7.3.1). A column that most of
 *    the pasted values do not fit refuses the whole paste: that block is aimed at the wrong column.
 *  - Everything happens in one transaction. Nothing is run: new rows only hold what was pasted.
 */
const { workbookRows, workbookCells } = schema;

export const MAX_PASTE_ROWS = 10_000;
export const MAX_PASTE_CELLS = 100_000;
export const MAX_PASTE_COLUMNS = 200;
const ROW_CHUNK = 1_000;
const CELL_CHUNK = 4_000;
const MAX_REPORTED = 100;

export interface PasteInput {
  columnIds: string[];
  /** One entry per row of the block, each as wide as `columnIds`. */
  values: string[][];
  /**
   * The existing rows the top of the block lands on: `rows` of them, in order, from `rowId` to `endRowId`. Without it
   * every row of the block is new. Naming the last one means a paste made against rows that have since changed is
   * refused instead of overwriting others.
   */
  start?: { rowId: number; endRowId: number; rows: number };
}

export interface PasteResult {
  /** Rows created. */
  added: number;
  /** Existing rows the paste wrote to. */
  updated: number;
  cellsWritten: number;
  cellsCleared: number;
  rowCount: number;
  /** Rows of the block past the last row that held nothing, so no row was made for them. */
  blankRows: number;
  /** Stored, and flagged because they do not fit their column's type. `row` counts from the top of the block. */
  invalid: { count: number; cells: Array<{ row: number; columnId: string; errorCode: string }> };
  /** Not stored: more than a cell can hold. The cell is left as it was. */
  rejected: { count: number; cells: Array<{ row: number; columnId: string; reason: string }> };
  /** Columns of the block that cannot be edited, with how many values were left out. */
  skippedColumns: Array<{ columnId: string; values: number }>;
}

interface Target {
  /** Place in the block. */
  at: number;
  columnId: string;
  type: InputDataType;
}

/** Refuses a paste in which any typed column would be filled mostly with values that do not belong in it. */
function refuseWrongColumns(targets: Target[], cells: NormalizedCell[][], values: string[][]) {
  const wrong = targets.flatMap((target, c) => {
    let filled = 0;
    let invalid = 0;
    for (const row of cells) {
      const cell = row[c]!;
      if (cell.kind !== "value") continue;
      filled += 1;
      if (cell.errorCode) invalid += 1;
    }
    if (invalid * 2 <= filled) return [];
    return [{ columnId: target.columnId, dataType: target.type, values: filled, invalid, looksLike: looksLike(values.map((row) => row[target.at]!)) }];
  });
  if (!wrong.length) return;
  throw new WorkbookV2Error(
    "INCOMPATIBLE_COLUMN",
    422,
    "Most of the pasted values don't fit the column they were pasted into. Nothing was pasted.",
    { columns: wrong }
  );
}

export async function pasteIntoWorkbook(db: Db, actor: WorkbookActor, workbookId: string, input: PasteInput): Promise<PasteResult> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await lockLiveWorkbook(tx, actor.workspaceId, workbookId);
    const columns = await columnsOf(tx, workbookId);

    const targets: Target[] = [];
    const skipped: PasteResult["skippedColumns"] = [];
    input.columnIds.forEach((requested, at) => {
      const column = columns.get(requested.toLowerCase());
      // A column that has gone refuses the paste: the values meant for it must not land anywhere else.
      if (!column) throw new WorkbookV2Error("UNKNOWN_COLUMN", 422, "This workbook has no such column", { columnId: requested });
      if (column.type === "input") targets.push({ at, columnId: column.id, type: inputDataType(column.config) });
      else skipped.push({ columnId: column.id, values: input.values.reduce((n, row) => n + (row[at]!.trim() ? 1 : 0), 0) });
    });
    if (!targets.length) throw new WorkbookV2Error("NOT_AN_INPUT_COLUMN", 422, "Only input columns can be pasted into");

    /** By block row, then by target. */
    const cells = input.values.map((row) => targets.map((t) => normalizeInputValue(row[t.at], t.type)));
    refuseWrongColumns(targets, cells, input.values);

    // The existing rows under the top of the block.
    let under: number[] = [];
    if (input.start) {
      const { rowId, endRowId, rows } = input.start;
      const [first] = await tx
        .select({ position: workbookRows.position })
        .from(workbookRows)
        .where(and(eq(workbookRows.workbookId, workbookId), eq(workbookRows.id, rowId)))
        .limit(1);
      if (first) {
        const found = await tx
          .select({ id: workbookRows.id })
          .from(workbookRows)
          .where(and(eq(workbookRows.workbookId, workbookId), gte(workbookRows.position, first.position)))
          .orderBy(asc(workbookRows.position))
          .limit(rows);
        under = found.map((r) => r.id);
      }
      if (under.length !== rows || under[0] !== rowId || under[under.length - 1] !== endRowId) {
        throw new WorkbookV2Error("ROWS_CHANGED", 409, "The rows changed while you were pasting. Check where you want to paste and try again.");
      }
    }

    const beyond = cells.slice(under.length);
    const fresh = beyond.filter((row) => row.some((cell) => cell.kind === "value"));
    const existing = await countRows(tx, workbookId);
    if (fresh.length) {
      const limit = await getWorkspaceRowLimit(tx, actor.workspaceId);
      if (existing + fresh.length > limit) {
        const room = Math.max(0, limit - existing);
        throw new WorkbookV2Error(
          "ROW_LIMIT_EXCEEDED",
          422,
          `This workspace allows ${limit.toLocaleString("en-US")} rows per workbook; there is room for ${room.toLocaleString("en-US")} more and this paste adds ${fresh.length.toLocaleString("en-US")}. Nothing was pasted.`,
          { limit, rows: existing, adding: fresh.length }
        );
      }
    }

    const result: PasteResult = {
      added: fresh.length,
      updated: 0,
      cellsWritten: 0,
      cellsCleared: 0,
      rowCount: existing + fresh.length,
      blankRows: beyond.length - fresh.length,
      invalid: { count: 0, cells: [] },
      rejected: { count: 0, cells: [] },
      skippedColumns: skipped,
    };
    const report = (row: number, target: Target, cell: NormalizedCell) => {
      if (cell.kind === "rejected") {
        result.rejected.count += 1;
        if (result.rejected.cells.length < MAX_REPORTED) result.rejected.cells.push({ row, columnId: target.columnId, reason: cell.reason });
      } else if (cell.kind === "value" && cell.errorCode) {
        result.invalid.count += 1;
        if (result.invalid.cells.length < MAX_REPORTED) result.invalid.cells.push({ row, columnId: target.columnId, errorCode: cell.errorCode });
      }
    };

    const writes: Array<ReturnType<typeof cellRecord>> = [];
    /** Per column, the existing rows whose cell is emptied. */
    const clears = new Map<string, number[]>();
    under.forEach((rowId, row) => {
      let touched = false;
      targets.forEach((target, c) => {
        const cell = cells[row]![c]!;
        report(row, target, cell);
        if (cell.kind === "value") writes.push(cellRecord(workbookId, rowId, target.columnId, cell));
        else if (cell.kind === "empty") {
          const list = clears.get(target.columnId);
          if (list) list.push(rowId);
          else clears.set(target.columnId, [rowId]);
        }
        if (cell.kind !== "rejected") touched = true;
      });
      if (touched) result.updated += 1;
    });

    for (const [columnId, rowIds] of clears) {
      const gone = await tx
        .delete(workbookCells)
        .where(and(eq(workbookCells.workbookId, workbookId), eq(workbookCells.columnId, columnId), inArray(workbookCells.rowId, rowIds)))
        .returning({ rowId: workbookCells.rowId });
      result.cellsCleared += gone.length;
    }

    if (fresh.length) {
      const [last] = await tx.select({ position: max(workbookRows.position) }).from(workbookRows).where(eq(workbookRows.workbookId, workbookId));
      const firstPosition = (last?.position ?? -1) + 1;
      const idAt = new Map<number, number>();
      for (let i = 0; i < fresh.length; i += ROW_CHUNK) {
        const inserted = await tx
          .insert(workbookRows)
          .values(fresh.slice(i, i + ROW_CHUNK).map((_, j) => ({ workbookId, position: firstPosition + i + j, source: { type: "paste" } })))
          .returning({ id: workbookRows.id, position: workbookRows.position });
        for (const r of inserted) idAt.set(r.position, r.id);
      }
      let made = 0;
      beyond.forEach((rowCells, i) => {
        if (!rowCells.some((cell) => cell.kind === "value")) {
          // No row is made, but a value that could not be stored is still reported.
          targets.forEach((target, c) => report(under.length + i, target, rowCells[c]!));
          return;
        }
        const rowId = idAt.get(firstPosition + made)!;
        made += 1;
        targets.forEach((target, c) => {
          const cell = rowCells[c]!;
          report(under.length + i, target, cell);
          if (cell.kind === "value") writes.push(cellRecord(workbookId, rowId, target.columnId, cell));
        });
      });
    }

    // New cells and overwritten ones alike: an overwritten cell loses whatever said where its old value came from.
    for (let i = 0; i < writes.length; i += CELL_CHUNK) {
      await tx
        .insert(workbookCells)
        .values(writes.slice(i, i + CELL_CHUNK))
        .onConflictDoUpdate({
          target: [workbookCells.workbookId, workbookCells.rowId, workbookCells.columnId],
          set: {
            value: sql`excluded.value`,
            state: sql`excluded.state`,
            errorCode: sql`excluded.error_code`,
            confidence: sql`excluded.confidence`,
            creditsCharged: sql`excluded.credits_charged`,
            foundVia: sql`excluded.found_via`,
            verification: sql`excluded.verification`,
            internalProvenance: sql`excluded.internal_provenance`,
            updatedAt: sql`now()`,
          },
        });
    }
    result.cellsWritten = writes.length;

    if (result.added || result.cellsWritten || result.cellsCleared) await touchWorkbook(tx, workbookId, result.rowCount);
    if (result.added) {
      await recordWorkbookActivity(tx, actor, workbookId, { action: "workbook.rows.added", after: { source: "paste", rows: result.added, rowCount: result.rowCount } });
    }
    return result;
  });
}
