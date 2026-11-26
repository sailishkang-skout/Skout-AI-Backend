import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { schema, scopedById, scopedTo, type Db } from "@skout/db";
import { recordPrivilegedAction } from "@skout/auth";
import { createLogger } from "@skout/observability";
import { EntitlementsService } from "./entitlements.service.js";

/**
 * Workbooks V2 CRUD (WB2-011). Every function takes the workspace id from the authenticated session and
 * scopes each query to it; the child tables have no workspace_id of their own, so they are only ever read
 * after (or joined to) a workbook found within that workspace. A workbook that is another workspace's,
 * soft-deleted or missing is indistinguishable from the outside: not found.
 */

const log = createLogger("workbook-v2");
const { workbooks, workbookColumns, workbookRows, workbookRuns, users } = schema;

/** Platform-managed entitlement holding a workspace's rows-per-workbook limit (PRD WB-4). */
export const WORKBOOK_ROW_LIMIT_ENTITLEMENT = "workbooks.row_limit";
export const DEFAULT_WORKBOOK_ROW_LIMIT = schema.WORKBOOK_DEFAULT_ROW_LIMIT;
export const WORKBOOK_RESTORE_DAYS = 30;
export const WORKBOOK_NAME_MAX = 200;
const COPY_SUFFIX = " (copy)";
const PG_INTEGER_MAX = 2_147_483_647;

export type WorkbookV2ErrorCode =
  | "NOT_FOUND"
  | "ROW_LIMIT_EXCEEDED"
  | "RESTORE_WINDOW_EXPIRED"
  | "WORKBOOK_NOT_DELETED"
  | "UNKNOWN_COLUMN"
  | "NOT_AN_INPUT_COLUMN"
  | "INVALID_CELL_VALUE"
  | "INVALID_COLUMN_CONFIG"
  | "COLUMN_IN_USE"
  | "COLUMN_LIMIT_EXCEEDED"
  | "COLUMN_ORDER_CONFLICT"
  | "COLUMN_ORDER_INVALID"
  | "COLUMN_NOT_RUNNABLE"
  | "NOT_IMPLEMENTED";

export class WorkbookV2Error extends Error {
  constructor(
    readonly code: WorkbookV2ErrorCode,
    readonly statusCode: number,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "WorkbookV2Error";
  }
}

const notFound = () => new WorkbookV2Error("NOT_FOUND", 404, "Workbook not found");

export interface WorkbookActor {
  workspaceId: string;
  /** Null for callers that are not a user row (they cannot be recorded as a creator). */
  userId: string | null;
}

export interface WorkbookSummary {
  id: string;
  name: string;
  rowCount: number;
  /** The workspace's current rows-per-workbook limit. */
  rowLimit: number;
  columnCount: number;
  lastRun: { id: string; columnId: string; status: string; createdAt: string; startedAt: string | null; finishedAt: string | null } | null;
  createdBy: { id: string; name: string | null; email: string } | null;
  createdAt: string;
  /** "Last edited". */
  updatedAt: string;
}

export interface WorkbookColumnDto {
  id: string;
  name: string;
  type: string;
  operation: string | null;
  config: Record<string, unknown>;
  position: number;
  width: number;
  hidden: boolean;
  frozen: boolean;
}

export type WorkbookDetail = WorkbookSummary & { columns: WorkbookColumnDto[]; archivedSourceId: string | null };

type WorkbookRecord = typeof workbooks.$inferSelect;
type Executor = Db;

/**
 * The workspace's rows-per-workbook limit: the `workbooks.row_limit` entitlement if it is a valid
 * non-negative integer, otherwise 100,000. A database failure is thrown, never swallowed into the
 * default, so an outage cannot lift a lower limit.
 */
export async function getWorkspaceRowLimit(db: Executor, workspaceId: string): Promise<number> {
  const entitlement = await new EntitlementsService(db).get(workspaceId, WORKBOOK_ROW_LIMIT_ENTITLEMENT);
  if (!entitlement) return DEFAULT_WORKBOOK_ROW_LIMIT;
  const value = entitlement.value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= PG_INTEGER_MAX) return value;
  log.warn("ignoring an invalid workbooks.row_limit entitlement", { workspaceId, value });
  return DEFAULT_WORKBOOK_ROW_LIMIT;
}

const live = (workspaceId: string, id: string) => and(scopedById(workbooks, workspaceId, id), isNull(workbooks.deletedAt));

/** The workspace's workbook, unless it is deleted. Anything else is "not found". */
export async function findLiveWorkbook(db: Executor, workspaceId: string, id: string): Promise<WorkbookRecord> {
  const [row] = await db.select().from(workbooks).where(live(workspaceId, id)).limit(1);
  if (!row) throw notFound();
  return row;
}

/**
 * The same, holding the workbook's row lock until the transaction ends. Every change to a workbook's rows takes it,
 * so positions, the row count and the row limit are decided one request at a time.
 */
export async function lockLiveWorkbook(tx: Executor, workspaceId: string, id: string): Promise<WorkbookRecord> {
  const [row] = await tx.select().from(workbooks).where(live(workspaceId, id)).limit(1).for("no key update");
  if (!row) throw notFound();
  return row;
}

/** Adds column counts, the latest run and the creator to workbooks already scoped to one workspace. */
async function summarize(db: Executor, rows: WorkbookRecord[], rowLimit: number): Promise<WorkbookSummary[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const creatorIds = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => x !== null))];
  const [columnCounts, lastRuns, creators] = await Promise.all([
    db.select({ workbookId: workbookColumns.workbookId, n: count() }).from(workbookColumns).where(inArray(workbookColumns.workbookId, ids)).groupBy(workbookColumns.workbookId),
    db
      .selectDistinctOn([workbookRuns.workbookId], {
        id: workbookRuns.id,
        workbookId: workbookRuns.workbookId,
        columnId: workbookRuns.columnId,
        status: workbookRuns.status,
        createdAt: workbookRuns.createdAt,
        startedAt: workbookRuns.startedAt,
        finishedAt: workbookRuns.finishedAt,
      })
      .from(workbookRuns)
      .where(inArray(workbookRuns.workbookId, ids))
      .orderBy(workbookRuns.workbookId, desc(workbookRuns.createdAt), desc(workbookRuns.id)),
    creatorIds.length ? db.select({ id: users.id, name: users.fullName, email: users.email }).from(users).where(inArray(users.id, creatorIds)) : Promise.resolve([]),
  ]);
  const columnsBy = new Map(columnCounts.map((c) => [c.workbookId, c.n]));
  const runBy = new Map(lastRuns.map((r) => [r.workbookId, r]));
  const creatorBy = new Map(creators.map((u) => [u.id, u]));
  return rows.map((w) => {
    const run = runBy.get(w.id);
    return {
      id: w.id,
      name: w.name,
      rowCount: w.rowCount,
      rowLimit,
      columnCount: columnsBy.get(w.id) ?? 0,
      lastRun: run
        ? {
            id: run.id,
            columnId: run.columnId,
            status: run.status,
            createdAt: run.createdAt.toISOString(),
            startedAt: run.startedAt?.toISOString() ?? null,
            finishedAt: run.finishedAt?.toISOString() ?? null,
          }
        : null,
      createdBy: (w.createdBy && creatorBy.get(w.createdBy)) || null,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    };
  });
}

async function detail(db: Executor, row: WorkbookRecord): Promise<WorkbookDetail> {
  const rowLimit = await getWorkspaceRowLimit(db, row.workspaceId);
  const [summary] = await summarize(db, [row], rowLimit);
  const columns = await db
    .select({
      id: workbookColumns.id,
      name: workbookColumns.name,
      type: workbookColumns.type,
      operation: workbookColumns.operation,
      config: workbookColumns.config,
      position: workbookColumns.position,
      width: workbookColumns.width,
      hidden: workbookColumns.hidden,
      frozen: workbookColumns.frozen,
    })
    .from(workbookColumns)
    .where(eq(workbookColumns.workbookId, row.id))
    .orderBy(asc(workbookColumns.position), asc(workbookColumns.id));
  return { ...summary!, columns, archivedSourceId: row.archivedSourceId };
}

export async function createWorkbook(db: Db, actor: WorkbookActor, input: { name: string }): Promise<WorkbookDetail> {
  const rowLimit = await getWorkspaceRowLimit(db, actor.workspaceId);
  const [row] = await db.insert(workbooks).values({ workspaceId: actor.workspaceId, name: input.name, createdBy: actor.userId, rowLimit }).returning();
  return detail(db, row!);
}

export async function listWorkbooks(db: Db, workspaceId: string, page: number, pageSize: number) {
  const where = scopedTo(workbooks, workspaceId, isNull(workbooks.deletedAt));
  const [rows, [totalRow], rowLimit] = await Promise.all([
    db
      .select()
      .from(workbooks)
      .where(where)
      .orderBy(desc(workbooks.updatedAt), desc(workbooks.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(workbooks).where(where),
    getWorkspaceRowLimit(db, workspaceId),
  ]);
  return { data: await summarize(db, rows, rowLimit), total: totalRow?.n ?? 0, page, pageSize };
}

export async function getWorkbook(db: Db, workspaceId: string, id: string): Promise<WorkbookDetail> {
  return detail(db, await findLiveWorkbook(db, workspaceId, id));
}

export async function renameWorkbook(db: Db, workspaceId: string, id: string, name: string): Promise<WorkbookDetail> {
  const [row] = await db.update(workbooks).set({ name, updatedAt: sql`now()` }).where(live(workspaceId, id)).returning();
  if (!row) throw notFound();
  return detail(db, row);
}

/**
 * Column configs refer to other columns by id (input mappings, conditions, formulas). Rewrite every such
 * reference, as a value or an object key, so the copy points at its own columns and not the source's.
 */
export function remapColumnReferences(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const [from, to] of ids) if (out.includes(from)) out = out.split(from).join(to);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => remapColumnReferences(v, ids));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [ids.get(k) ?? k, remapColumnReferences(v, ids)]));
  }
  return value;
}

/**
 * A new, independent workbook with the source's columns and, optionally, its rows and their cell values.
 *
 * Not copied, on purpose: runs, imports, saved views and inbound webhooks (a copied token would feed two
 * workbooks). In copied cells `credits_charged` is 0 (nothing was charged for the copy), and cells that
 * are queued or running are left out: no run exists in the new workbook to finish them.
 *
 * One transaction on a single snapshot: the row-limit check and the copy see the same rows, and a failure
 * leaves nothing behind.
 */
export async function duplicateWorkbook(db: Db, actor: WorkbookActor, sourceId: string, input: { includeRows: boolean; name?: string }): Promise<WorkbookDetail> {
  const created = await db.transaction(
    async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const source = await findLiveWorkbook(tx, actor.workspaceId, sourceId);
      const rowLimit = await getWorkspaceRowLimit(tx, actor.workspaceId);

      let rows = 0;
      if (input.includeRows) {
        // Counted from the rows themselves: the stored row_count is a display figure.
        const [counted] = await tx.select({ n: count() }).from(workbookRows).where(eq(workbookRows.workbookId, source.id));
        rows = counted?.n ?? 0;
        if (rows > rowLimit) {
          throw new WorkbookV2Error("ROW_LIMIT_EXCEEDED", 422, `This workspace allows ${rowLimit.toLocaleString("en-US")} rows per workbook; the workbook has ${rows.toLocaleString("en-US")}.`, {
            limit: rowLimit,
            rows,
          });
        }
      }

      const name = input.name ?? `${source.name.slice(0, WORKBOOK_NAME_MAX - COPY_SUFFIX.length)}${COPY_SUFFIX}`;
      const [copy] = await tx.insert(workbooks).values({ workspaceId: actor.workspaceId, name, createdBy: actor.userId, rowLimit, rowCount: rows }).returning();

      const columns = await tx.select().from(workbookColumns).where(eq(workbookColumns.workbookId, source.id));
      const columnIds = new Map(columns.map((c) => [c.id, randomUUID() as string]));
      if (columns.length) {
        await tx.insert(workbookColumns).values(
          columns.map((c) => ({
            id: columnIds.get(c.id)!,
            workbookId: copy!.id,
            name: c.name,
            type: c.type,
            operation: c.operation,
            config: remapColumnReferences(c.config, columnIds) as Record<string, unknown>,
            position: c.position,
            width: c.width,
            hidden: c.hidden,
            frozen: c.frozen,
          }))
        );
      }

      if (rows > 0) await copyRowsAndCells(tx, source.id, copy!.id, columnIds);
      return copy!;
    },
    { isolationLevel: "repeatable read" }
  );
  return detail(db, created);
}

/**
 * Set-based copy (a full workbook is millions of cells): each source row is given its new identity value
 * first, so cells can be re-pointed in the same statement.
 */
async function copyRowsAndCells(tx: Db, sourceId: string, targetId: string, columnIds: ReadonlyMap<string, string>): Promise<void> {
  const columnMap = columnIds.size
    ? sql.join(
        [...columnIds].map(([from, to]) => sql`(${from}::uuid, ${to}::uuid)`),
        sql`, `
      )
    : sql`(NULL::uuid, NULL::uuid)`;
  await tx.execute(sql`
    WITH row_map AS MATERIALIZED (
      SELECT r.id AS old_id, nextval(pg_get_serial_sequence('workbook_rows', 'id')) AS new_id
      FROM (SELECT id FROM workbook_rows WHERE workbook_id = ${sourceId} ORDER BY id) r
    ),
    new_rows AS (
      INSERT INTO workbook_rows (id, workbook_id, position, source, prospect_id, crm_ref, suppressed)
      OVERRIDING SYSTEM VALUE
      SELECT m.new_id, ${targetId}::uuid, r.position, r.source, r.prospect_id, r.crm_ref, r.suppressed
      FROM row_map m JOIN workbook_rows r ON r.id = m.old_id AND r.workbook_id = ${sourceId}
    ),
    column_map (old_id, new_id) AS (VALUES ${columnMap})
    INSERT INTO workbook_cells (workbook_id, row_id, column_id, value, state, confidence, credits_charged, found_via, internal_provenance, error_code, updated_at)
    SELECT ${targetId}::uuid, m.new_id, cm.new_id, c.value, c.state, c.confidence, 0, c.found_via, c.internal_provenance, c.error_code, c.updated_at
    FROM workbook_cells c
    JOIN row_map m ON m.old_id = c.row_id
    JOIN column_map cm ON cm.old_id = c.column_id
    WHERE c.workbook_id = ${sourceId} AND c.state NOT IN ('queued', 'running')
  `);
}

const restorableUntil = (deletedAt: Date) => new Date(deletedAt.getTime() + WORKBOOK_RESTORE_DAYS * 24 * 60 * 60 * 1000).toISOString();

/** Soft delete. "Last edited" is left alone, so a restored workbook reads as it did. */
export async function deleteWorkbook(db: Db, actor: WorkbookActor, id: string) {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const [row] = await tx.update(workbooks).set({ deletedAt: sql`now()` }).where(live(actor.workspaceId, id)).returning();
    if (!row) throw notFound();
    const result = { id: row.id, deletedAt: row.deletedAt!.toISOString(), restorableUntil: restorableUntil(row.deletedAt!) };
    await recordPrivilegedAction(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId ?? undefined,
      action: "workbook.delete",
      entityType: "workbook",
      entityId: row.id,
      afterState: { name: row.name, deletedAt: result.deletedAt },
    });
    return result;
  });
}

/** Undo a soft delete, within 30 days of it (the database clock decides, in the same statement). */
export async function restoreWorkbook(db: Db, actor: WorkbookActor, id: string): Promise<WorkbookDetail> {
  const restored = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const [before] = await tx.select().from(workbooks).where(scopedById(workbooks, actor.workspaceId, id)).limit(1).for("update");
    if (!before) throw notFound();
    if (!before.deletedAt) throw new WorkbookV2Error("WORKBOOK_NOT_DELETED", 409, "This workbook is not deleted.");
    const [row] = await tx
      .update(workbooks)
      .set({ deletedAt: null })
      .where(
        and(
          scopedById(workbooks, actor.workspaceId, id),
          isNotNull(workbooks.deletedAt),
          sql`${workbooks.deletedAt} >= now() - make_interval(days => ${WORKBOOK_RESTORE_DAYS})`
        )
      )
      .returning();
    if (!row) {
      throw new WorkbookV2Error("RESTORE_WINDOW_EXPIRED", 410, `Deleted workbooks can be restored for ${WORKBOOK_RESTORE_DAYS} days; this one was deleted earlier.`, {
        deletedAt: before.deletedAt.toISOString(),
        restorableUntil: restorableUntil(before.deletedAt),
      });
    }
    await recordPrivilegedAction(tx, {
      workspaceId: actor.workspaceId,
      actorId: actor.userId ?? undefined,
      action: "workbook.restore",
      entityType: "workbook",
      entityId: row.id,
      beforeState: { deletedAt: before.deletedAt.toISOString() },
    });
    return row;
  });
  return detail(db, restored);
}
