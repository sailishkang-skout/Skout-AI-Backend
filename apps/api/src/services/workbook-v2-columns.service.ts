import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { schema, scopedById, scopedTo, type Db } from "@skout/db";
import { recordPrivilegedAction } from "@skout/auth";
import { WorkbookV2Error, lockLiveWorkbook, type WorkbookActor, type WorkbookColumnDto } from "./workbook-v2.service.js";
import { inputDataType, normalizeInputValue, type InputDataType } from "./workbook-cell-values.js";
import {
  hasReferenceCycle,
  mentions,
  parseColumnConfig,
  referenceProblems,
  type ColumnShape,
  type ColumnType,
  type ConfigProblem,
  type ExternalTargets,
} from "./workbook-v2-column-config.js";

/**
 * Workbooks V2 columns (WB2-013). Every change takes the workbook's row lock first (the same one row changes take), so
 * positions, references and cells are decided one request at a time. Column positions are always 0, 1, 2 … with frozen
 * columns first: the grid pins a leading block, so a column cannot be frozen in the middle of unfrozen ones.
 */
const { workbooks, workbookColumns, workbookCells, workbookViews, workspaceIntegrations, sequences, lists, crmConnections } = schema;

/** Matches the number of columns the rows API reads and writes per row. */
export const MAX_COLUMNS = 200;
export const COLUMN_WIDTH_MIN = 60;
export const COLUMN_WIDTH_MAX = 1_000;
const REVALIDATE_BATCH = 5_000;

export interface NewColumn {
  name: string;
  type: ColumnType;
  operation?: string | null;
  config?: Record<string, unknown>;
  /** Where to insert, from 0. Default: the end, or the end of the frozen block for a frozen column. */
  position?: number;
  width?: number;
  hidden?: boolean;
  frozen?: boolean;
}

export interface ColumnPatch {
  name?: string;
  config?: Record<string, unknown>;
  width?: number;
  hidden?: boolean;
  frozen?: boolean;
}

export interface ColumnChange {
  data: WorkbookColumnDto;
  /** Every column in order: a change to one can move others. */
  columns: WorkbookColumnDto[];
}

type ColumnRecord = typeof workbookColumns.$inferSelect;

const toDto = (c: ColumnRecord): WorkbookColumnDto => ({
  id: c.id,
  name: c.name,
  type: c.type,
  operation: c.operation,
  config: c.config,
  position: c.position,
  width: c.width,
  hidden: c.hidden,
  frozen: c.frozen,
});

const columnsInOrder = (db: Db, workbookId: string) =>
  db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, workbookId)).orderBy(asc(workbookColumns.position), asc(workbookColumns.id));

const columnNotFound = () => new WorkbookV2Error("NOT_FOUND", 404, "Column not found");

function invalidConfig(problems: ConfigProblem[]) {
  const first = problems[0]!;
  return new WorkbookV2Error("INVALID_COLUMN_CONFIG", 422, first.path ? `${first.path}: ${first.message}` : first.message, { errors: problems.slice(0, 50), errorCount: problems.length });
}

/** The things outside the workbook a config names must exist in the caller's workspace. Anything else reads as missing. */
async function targetProblems(db: Db, workspaceId: string, targets: ExternalTargets): Promise<ConfigProblem[]> {
  const problems: ConfigProblem[] = [];
  const ownKeys = targets.ownKeyProviders ?? [];
  if (ownKeys.length) {
    const connected = await db
      .select({ provider: workspaceIntegrations.provider })
      .from(workspaceIntegrations)
      .where(
        scopedTo(
          workspaceIntegrations,
          workspaceId,
          eq(workspaceIntegrations.status, "active"),
          inArray(
            workspaceIntegrations.provider,
            ownKeys.map((k) => k.provider)
          )
        )
      );
    const have = new Set(connected.map((c) => c.provider));
    for (const k of ownKeys) if (!have.has(k.provider)) problems.push({ path: k.path, message: "Connect this provider's key in Settings → Data providers first" });
  }
  if (targets.sequenceId) {
    const [found] = await db.select({ id: sequences.id }).from(sequences).where(scopedById(sequences, workspaceId, targets.sequenceId)).limit(1);
    if (!found) problems.push({ path: "sequenceId", message: "Sequence not found" });
  }
  if (targets.listId) {
    const [found] = await db.select({ id: lists.id }).from(lists).where(scopedById(lists, workspaceId, targets.listId)).limit(1);
    if (!found) problems.push({ path: "listId", message: "List not found" });
  }
  if (targets.crmProvider) {
    const [found] = await db
      .select({ id: crmConnections.id })
      .from(crmConnections)
      .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, targets.crmProvider), eq(crmConnections.status, "connected")))
      .limit(1);
    if (!found) problems.push({ path: "provider", message: "Connect this CRM first" });
  }
  return problems;
}

/** Parses a config and checks everything it points at; returns what to store. */
async function checkedConfig(db: Db, workspaceId: string, column: ColumnShape, config: unknown, others: ColumnRecord[]) {
  const parsed = parseColumnConfig(column.type as ColumnType, column.operation, config);
  if (!parsed.ok) throw invalidConfig(parsed.problems);
  const next: ColumnShape = { ...column, operation: parsed.operation, config: parsed.config };
  const byId = new Map<string, ColumnShape>([...others, next].map((c) => [c.id, c]));
  const problems = referenceProblems(next.id, parsed.references, byId);
  if (!problems.length && hasReferenceCycle(next.id, byId)) problems.push({ path: "", message: "These columns would depend on each other in a circle" });
  problems.push(...(await targetProblems(db, workspaceId, parsed.targets)));
  if (problems.length) throw invalidConfig(problems);
  return { config: parsed.config, operation: parsed.operation, byId };
}

/**
 * Refuses a change that would break a column reading the changed one, directly or through other columns: removing a
 * company-data field in use, or turning a column that (via a formula) feeds "Verify email" into numbers. Only the
 * columns downstream of the change are checked, and only for problems it introduces, so a fault that was already there
 * never blocks an edit.
 */
function assertDependentsStillValid(changedId: string, before: ReadonlyMap<string, ColumnShape>, after: ReadonlyMap<string, ColumnShape>) {
  const downstream = new Set([changedId]);
  // A formula's kind follows from what it reads, so keep going until nothing new reads anything affected.
  for (let size = 0; size !== downstream.size; ) {
    size = downstream.size;
    for (const column of after.values()) if ([...downstream].some((id) => mentions(column, id))) downstream.add(column.id);
  }
  const broken: Array<{ columnId: string; name: string; problems: ConfigProblem[] }> = [];
  for (const dependent of after.values()) {
    if (dependent.id === changedId || !downstream.has(dependent.id)) continue;
    const parsed = parseColumnConfig(dependent.type as ColumnType, dependent.operation, dependent.config);
    if (!parsed.ok) continue;
    const affected = parsed.references.filter((r) => downstream.has(r.columnId));
    const existed = new Set(referenceProblems(dependent.id, affected, before).map((p) => `${p.path} ${p.message}`));
    const problems = referenceProblems(dependent.id, affected, after).filter((p) => !existed.has(`${p.path} ${p.message}`));
    if (problems.length) broken.push({ columnId: dependent.id, name: dependent.name, problems });
  }
  if (broken.length) {
    throw new WorkbookV2Error("COLUMN_IN_USE", 409, `This change would break "${broken[0]!.name}". Update it first.`, { dependents: broken.slice(0, 50) });
  }
}

/** Frozen columns must be one block at the start. */
function assertFrozenFirst(order: Array<{ frozen: boolean }>) {
  const firstUnfrozen = order.findIndex((c) => !c.frozen);
  if (firstUnfrozen !== -1 && order.slice(firstUnfrozen).some((c) => c.frozen)) {
    throw new WorkbookV2Error("COLUMN_ORDER_INVALID", 422, "Frozen columns come first. Freeze or unfreeze the column instead of moving it across that edge.");
  }
}

/** Writes positions 0, 1, 2 … in the given order, touching only the columns that move. */
async function writeOrder(tx: Db, workbookId: string, order: Array<{ id: string }>) {
  if (!order.length) return;
  const values = sql.join(
    order.map((c, position) => sql`(${c.id}::uuid, ${position}::int)`),
    sql`, `
  );
  await tx.execute(sql`
    UPDATE workbook_columns c SET position = o.position, updated_at = now()
    FROM (VALUES ${values}) AS o (id, position)
    WHERE c.workbook_id = ${workbookId} AND c.id = o.id AND c.position <> o.position
  `);
}

const touchWorkbook = (tx: Db, workbookId: string) => tx.update(workbooks).set({ updatedAt: sql`now()` }).where(eq(workbooks.id, workbookId));

/** One transaction holding the workbook's lock, with its columns in order. */
function withColumns<T>(db: Db, actor: WorkbookActor, workbookId: string, run: (tx: Db, columns: ColumnRecord[]) => Promise<T>): Promise<T> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await lockLiveWorkbook(tx, actor.workspaceId, workbookId);
    return run(tx, await columnsInOrder(tx, workbookId));
  });
}

async function change(tx: Db, workbookId: string, columnId: string): Promise<ColumnChange> {
  const columns = (await columnsInOrder(tx, workbookId)).map(toDto);
  return { data: columns.find((c) => c.id === columnId)!, columns };
}

export async function addColumn(db: Db, actor: WorkbookActor, workbookId: string, input: NewColumn): Promise<ColumnChange> {
  return withColumns(db, actor, workbookId, async (tx, columns) => {
    if (columns.length >= MAX_COLUMNS) {
      throw new WorkbookV2Error("COLUMN_LIMIT_EXCEEDED", 422, `A workbook can have ${MAX_COLUMNS} columns.`, { limit: MAX_COLUMNS, columns: columns.length });
    }
    const id = randomUUID();
    const draft: ColumnShape = { id, name: input.name, type: input.type, operation: input.operation ?? null, config: {} };
    const checked = await checkedConfig(tx, actor.workspaceId, draft, input.config ?? {}, columns);

    const frozen = input.frozen ?? false;
    const frozenCount = columns.filter((c) => c.frozen).length;
    const position = input.position ?? (frozen ? frozenCount : columns.length);
    if (position > columns.length) throw new WorkbookV2Error("COLUMN_ORDER_INVALID", 422, `Positions run from 0 to ${columns.length}.`);
    const order: Array<{ id: string; frozen: boolean }> = [...columns];
    order.splice(position, 0, { id, frozen });
    assertFrozenFirst(order);

    await tx.insert(workbookColumns).values({
      id,
      workbookId,
      name: input.name,
      type: input.type,
      operation: checked.operation,
      config: checked.config,
      position,
      width: input.width,
      hidden: input.hidden,
      frozen,
    });
    await writeOrder(tx, workbookId, order);
    await touchWorkbook(tx, workbookId);
    return change(tx, workbookId, id);
  });
}

/**
 * Re-reads an input column's stored values as its new type, so flags, sorting and filtering match it: a value that fits
 * is converted, one that does not is kept and flagged (the same rules as typing it in).
 */
async function revalidateCells(tx: Db, workbookId: string, columnId: string, dataType: InputDataType): Promise<void> {
  let after = 0;
  for (;;) {
    const cells = await tx
      .select({ rowId: workbookCells.rowId, value: workbookCells.value, state: workbookCells.state, errorCode: workbookCells.errorCode })
      .from(workbookCells)
      .where(and(eq(workbookCells.workbookId, workbookId), eq(workbookCells.columnId, columnId), gt(workbookCells.rowId, after)))
      .orderBy(asc(workbookCells.rowId))
      .limit(REVALIDATE_BATCH);
    const changed = cells.flatMap((cell) => {
      if (cell.state !== "found" && cell.state !== "error") return [];
      const next = normalizeInputValue(cell.value, dataType);
      // Empty or unstorable under the new type: leave the cell as it is rather than lose what was typed.
      if (next.kind !== "value") return [];
      if (next.value === cell.value && next.errorCode === cell.errorCode) return [];
      return [{ row_id: cell.rowId, value: next.value, state: next.errorCode ? "error" : "found", error_code: next.errorCode }];
    });
    if (changed.length) {
      await tx.execute(sql`
        UPDATE workbook_cells c SET value = u.value, state = u.state, error_code = u.error_code, updated_at = now()
        FROM jsonb_to_recordset(${JSON.stringify(changed)}::text::jsonb) AS u (row_id bigint, value jsonb, state text, error_code text)
        WHERE c.workbook_id = ${workbookId} AND c.column_id = ${columnId} AND c.row_id = u.row_id
      `);
    }
    if (cells.length < REVALIDATE_BATCH) return;
    after = cells[cells.length - 1]!.rowId;
  }
}

export async function updateColumn(db: Db, actor: WorkbookActor, workbookId: string, columnId: string, patch: ColumnPatch): Promise<ColumnChange> {
  return withColumns(db, actor, workbookId, async (tx, columns) => {
    const column = columns.find((c) => c.id === columnId.toLowerCase());
    if (!column) throw columnNotFound();

    let config: Record<string, unknown> | undefined;
    if (patch.config !== undefined) {
      const others = columns.filter((c) => c.id !== column.id);
      const checked = await checkedConfig(tx, actor.workspaceId, column, patch.config, others);
      config = checked.config;
      assertDependentsStillValid(column.id, new Map(columns.map((c) => [c.id, c])), checked.byId);
      if (column.type === "input" && inputDataType(config) !== inputDataType(column.config)) await revalidateCells(tx, workbookId, column.id, inputDataType(config));
    }

    await tx
      .update(workbookColumns)
      .set({ name: patch.name, config, width: patch.width, hidden: patch.hidden, frozen: patch.frozen, updatedAt: sql`now()` })
      .where(and(eq(workbookColumns.workbookId, workbookId), eq(workbookColumns.id, column.id)));

    if (patch.frozen !== undefined && patch.frozen !== column.frozen) {
      // Freezing moves the column to the end of the frozen block; unfreezing to the start of the rest. Both are that edge.
      const rest = columns.filter((c) => c.id !== column.id);
      const edge = rest.filter((c) => c.frozen).length;
      rest.splice(edge, 0, { ...column, frozen: patch.frozen });
      await writeOrder(tx, workbookId, rest);
    }
    await touchWorkbook(tx, workbookId);
    return change(tx, workbookId, column.id);
  });
}

/**
 * Puts every column in the given order. The list must name each column exactly once, so a caller working from an out of
 * date list is refused. `previousColumnIds`, the order the caller started from, also refuses overwriting someone else's
 * reorder.
 */
export async function reorderColumns(
  db: Db,
  actor: WorkbookActor,
  workbookId: string,
  input: { columnIds: string[]; previousColumnIds?: string[] }
): Promise<WorkbookColumnDto[]> {
  return withColumns(db, actor, workbookId, async (tx, columns) => {
    const byId = new Map(columns.map((c) => [c.id, c]));
    const current = columns.map((c) => c.id);
    const wanted = input.columnIds.map((id) => id.toLowerCase());
    const previous = input.previousColumnIds?.map((id) => id.toLowerCase());
    const stale = wanted.length !== current.length || wanted.some((id) => !byId.has(id)) || (previous !== undefined && previous.join() !== current.join());
    if (stale) {
      throw new WorkbookV2Error("COLUMN_ORDER_CONFLICT", 409, "The columns have changed. Reload them and try again.", { columnIds: current });
    }
    const order = wanted.map((id) => byId.get(id)!);
    assertFrozenFirst(order);
    await writeOrder(tx, workbookId, order);
    await touchWorkbook(tx, workbookId);
    return (await columnsInOrder(tx, workbookId)).map(toDto);
  });
}

/**
 * Deletes a column and, through the foreign keys, its cells and run history. Refused while another column reads it.
 * Saved views stop mentioning it. Permanent, so it is audited.
 */
export async function deleteColumn(db: Db, actor: WorkbookActor, workbookId: string, columnId: string): Promise<{ id: string; columns: WorkbookColumnDto[] }> {
  return withColumns(db, actor, workbookId, async (tx, columns) => {
    const column = columns.find((c) => c.id === columnId.toLowerCase());
    if (!column) throw columnNotFound();
    const dependents = columns.filter((c) => mentions(c, column.id));
    if (dependents.length) {
      throw new WorkbookV2Error("COLUMN_IN_USE", 409, `"${dependents[0]!.name}" uses this column. Change or delete it first.`, {
        dependents: dependents.map((c) => ({ columnId: c.id, name: c.name })),
      });
    }

    await tx.delete(workbookColumns).where(and(eq(workbookColumns.workbookId, workbookId), eq(workbookColumns.id, column.id)));
    const rest = columns.filter((c) => c.id !== column.id);
    await writeOrder(tx, workbookId, rest);

    const uses = (entry: unknown) => JSON.stringify(entry).toLowerCase().includes(column.id);
    const views = await tx.select().from(workbookViews).where(eq(workbookViews.workbookId, workbookId));
    for (const view of views) {
      if (!uses([view.filters, view.sorts, view.hiddenColumns])) continue;
      await tx
        .update(workbookViews)
        .set({
          filters: view.filters.filter((f) => !uses(f)),
          sorts: view.sorts.filter((s) => !uses(s)),
          hiddenColumns: view.hiddenColumns.filter((h) => !uses(h)),
          updatedAt: sql`now()`,
        })
        .where(eq(workbookViews.id, view.id));
    }

    await touchWorkbook(tx, workbookId);
    await recordPrivilegedAction(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId ?? undefined,
      action: "workbook.column.delete",
      entityType: "workbook",
      entityId: workbookId,
      beforeState: { columnId: column.id, name: column.name, type: column.type, operation: column.operation },
    });
    return { id: column.id, columns: (await columnsInOrder(tx, workbookId)).map(toDto) };
  });
}

/**
 * Webhook addresses often carry a secret in their path. Someone who may only view a workbook sees which host a column
 * sends to, not the address.
 */
export function redactColumnForViewer<C extends { type: string; operation: string | null; config: Record<string, unknown> }>(column: C): C {
  if (column.type !== "action" || column.operation !== "send_to_webhook") return column;
  const { url } = column.config;
  let host = "";
  try {
    host = typeof url === "string" ? new URL(url).origin : "";
  } catch {
    host = "";
  }
  return { ...column, config: { ...column.config, url: host ? `${host}/…` : "…" } };
}
