import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { schema, scopedById, type Db } from "@skout/db";
import { WORKBOOK_ACTIVITY_TYPES, WORKBOOK_ENTITY, recordWorkbookActivity, type ActivityActor, type WorkbookAction } from "./workbook-activity-log.js";
import { WorkbookV2Error, findLiveWorkbook } from "./workbook-v2.service.js";
import { CRM_PROVIDERS } from "./workbook-v2-column-config.js";

/**
 * Reading a workbook's activity, and recording what background work does: runs, exports and CRM pushes (WB2-016).
 *
 * Nothing runs, exports or pushes yet. The recorders are what those tickets call (WB2-050 runs, WB2-064 CRM push,
 * WB2-090 export). Each takes the workspace from the server's own job, finds who did it from stored records, checks
 * the workbook belongs to that workspace, and records a given step once however often it is reported.
 */
const { auditLogs, users, workbooks, workbookRuns, workbookColumns } = schema;

// ── Shared with the run engine ────────────────────────────────────────────────

/**
 * The credit ledger `referenceId` every charge of a workbook run must carry (PRD BILL-4: workbook, run and row), with
 * the row for a per-row charge. Activity reads a run's actual cost from the ledger entries that carry it, and from
 * corrections of those entries, so it cannot drift from billing.
 */
export const workbookRunLedgerReference = (workbookId: string, runId: string, rowId?: number) =>
  `workbook:${workbookId.toLowerCase()}:run:${runId.toLowerCase()}${rowId === undefined ? "" : `:row:${rowId}`}`;

/** Net credits the ledger shows each run charged: its entries, less refunds and other corrections of them. */
export async function chargedCredits(db: Db, workspaceId: string, workbookId: string, runIds: string[]): Promise<Map<string, number>> {
  if (!runIds.length) return new Map();
  const prefix = `workbook:${workbookId.toLowerCase()}:run:`;
  const wanted = sql.join(
    runIds.map((id) => sql`${id}`),
    sql`, `
  );
  // UNION, not UNION ALL: an entry that both carries the reference and corrects another is counted once.
  const rows = (await db.execute(sql`
    WITH RECURSIVE entries (id, amount, run_id) AS (
      SELECT t.id, t.amount, split_part(t.reference_id, ':', 4)
      FROM credit_transactions t
      WHERE t.workspace_id = ${workspaceId} AND starts_with(t.reference_id, ${prefix}) AND split_part(t.reference_id, ':', 4) IN (${wanted})
      UNION
      SELECT c.id, c.amount, e.run_id
      FROM credit_transactions c JOIN entries e ON c.compensates_id = e.id
      WHERE c.workspace_id = ${workspaceId}
    )
    SELECT run_id, (-sum(amount))::int AS credits FROM entries GROUP BY run_id
  `)) as unknown as Array<{ run_id: string; credits: number }>;
  return new Map(rows.map((r) => [r.run_id, Number(r.credits)]));
}

// ── Recording background work ─────────────────────────────────────────────────

/** How a run or push ended. `interrupted` is not final: the job may resume and report again. */
export const END_STATUSES = ["completed", "failed", "cancelled", "interrupted"] as const;
export type EndStatus = (typeof END_STATUSES)[number];

export const EXPORT_STATUSES = ["started", "completed", "failed", "cancelled"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export interface Recorded {
  /** False when this step was already recorded, or the work had already ended. */
  recorded: boolean;
}

const invalid = (message: string) => new WorkbookV2Error("INVALID_ACTIVITY", 422, message);
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

type Stored = Record<string, unknown>;

/** What has already been recorded for one run or export. */
async function history(tx: Db, workspaceId: string, workbookId: string, action: WorkbookAction, key: "runId" | "exportId", id: string): Promise<Stored[]> {
  const rows = await tx
    .select({ after: auditLogs.afterState })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.workspaceId, workspaceId),
        eq(auditLogs.entityType, WORKBOOK_ENTITY),
        eq(auditLogs.entityId, workbookId),
        eq(auditLogs.action, action),
        sql`${auditLogs.afterState} ->> ${key} = ${id}`
      )
    );
  return rows.map((r) => (r.after ?? {}) as Stored);
}

/** True when an end like this one is already recorded: any final one, or this same interruption. */
const alreadyEnded = (ends: Stored[], status: EndStatus, attempt: number) =>
  ends.some((e) => e.status !== "interrupted") || (status === "interrupted" && ends.some((e) => e.attempt === attempt));

/**
 * The run, its column and who started it, locked until the transaction ends so that two reports about one run are
 * decided one after the other. A run outside the workspace is not found.
 */
async function lockRun(tx: Db, workspaceId: string, runId: string) {
  const [found] = await tx
    .select({ run: workbookRuns })
    .from(workbookRuns)
    .innerJoin(workbooks, eq(workbooks.id, workbookRuns.workbookId))
    .where(and(eq(workbookRuns.id, runId), eq(workbooks.workspaceId, workspaceId)))
    .for("no key update", { of: workbookRuns });
  if (!found) throw new WorkbookV2Error("NOT_FOUND", 404, "Run not found");
  const [column] = await tx
    .select({ name: workbookColumns.name, operation: workbookColumns.operation, config: workbookColumns.config })
    .from(workbookColumns)
    .where(and(eq(workbookColumns.workbookId, found.run.workbookId), eq(workbookColumns.id, found.run.columnId)));
  // The person who started the run, as the server recorded it: never an argument.
  const actor: ActivityActor = { workspaceId, userId: found.run.startedBy, requestId: found.run.id };
  return { run: found.run, column: column!, actor };
}

function inTransaction<T>(db: Db, run: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction((tx) => run(tx as unknown as Db));
}

/**
 * A run has been accepted. Call it in the transaction that accepts the run. `rows` is how many rows were selected; the
 * most it can cost is the run's `max_credits`.
 */
export async function recordRunStarted(db: Db, workspaceId: string, runId: string, input: { rows: number }): Promise<Recorded> {
  if (!isCount(input.rows)) throw invalid("rows must be a whole number of rows");
  return inTransaction(db, async (tx) => {
    const { run, column, actor } = await lockRun(tx, workspaceId, runId);
    if ((await history(tx, workspaceId, run.workbookId, "workbook.run.started", "runId", run.id)).length) return { recorded: false };
    // A late report about a run that has already ended would read as if it had started again.
    const ends = await history(tx, workspaceId, run.workbookId, "workbook.run.finished", "runId", run.id);
    if (ends.some((e) => e.status !== "interrupted")) return { recorded: false };
    await recordWorkbookActivity(tx, actor, run.workbookId, {
      action: "workbook.run.started",
      channel: "worker",
      after: { runId: run.id, columnId: run.columnId, columnName: column.name, scope: run.scope, rows: input.rows, maxCredits: run.maxCredits },
    });
    return { recorded: true };
  });
}

/**
 * A run has stopped. Report `failed` only when it will not be retried; use `interrupted`, with the job's attempt
 * number, when it may resume. The first final status stands. What it cost is taken from the ledger, never from the
 * estimate.
 */
export async function recordRunFinished(db: Db, workspaceId: string, runId: string, input: { status: EndStatus; attempt?: number }): Promise<Recorded> {
  if (!END_STATUSES.includes(input.status)) throw invalid(`status must be one of ${END_STATUSES.join(", ")}`);
  const attempt = input.attempt ?? 1;
  if (!isCount(attempt)) throw invalid("attempt must be a whole number");
  return inTransaction(db, async (tx) => {
    const { run, column, actor } = await lockRun(tx, workspaceId, runId);
    const ends = await history(tx, workspaceId, run.workbookId, "workbook.run.finished", "runId", run.id);
    if (alreadyEnded(ends, input.status, attempt)) return { recorded: false };
    const [started] = await history(tx, workspaceId, run.workbookId, "workbook.run.started", "runId", run.id);
    const charged = await chargedCredits(tx, workspaceId, run.workbookId, [run.id]);
    await recordWorkbookActivity(tx, actor, run.workbookId, {
      action: "workbook.run.finished",
      channel: "worker",
      after: {
        runId: run.id,
        columnId: run.columnId,
        columnName: column.name,
        status: input.status,
        ...(input.status === "interrupted" ? { attempt } : {}),
        rows: started?.rows ?? null,
        maxCredits: run.maxCredits,
        // What the ledger showed at this moment, for the audit trail. The feed reads the ledger again.
        creditsAtFinish: charged.get(run.id) ?? 0,
      },
    });
    return { recorded: true };
  });
}

export interface CrmPushResult {
  status: EndStatus;
  attempt?: number;
  /** Records sent to the CRM. */
  attempted: number;
  succeeded: number;
  failed: number;
  /** Records not sent, e.g. suppressed people. */
  skipped: number;
}

/** What a run of a Push to CRM column did. The destination comes from the column's settings. */
export async function recordCrmPush(db: Db, workspaceId: string, runId: string, result: CrmPushResult): Promise<Recorded> {
  const { status, attempted, succeeded, failed, skipped } = result;
  if (!END_STATUSES.includes(status)) throw invalid(`status must be one of ${END_STATUSES.join(", ")}`);
  const attempt = result.attempt ?? 1;
  if (![attempt, attempted, succeeded, failed, skipped].every(isCount)) throw invalid("counts must be whole numbers");
  if (succeeded + failed > attempted) throw invalid("succeeded and failed cannot exceed attempted");
  if (status === "completed" && succeeded + failed !== attempted) throw invalid("a completed push accounts for every record it attempted");
  return inTransaction(db, async (tx) => {
    const { run, column, actor } = await lockRun(tx, workspaceId, runId);
    const provider = (column.config as { provider?: unknown }).provider;
    if (column.operation !== "push_to_crm" || !(CRM_PROVIDERS as readonly unknown[]).includes(provider)) throw invalid("This run is not a Push to CRM run");
    const ends = await history(tx, workspaceId, run.workbookId, "workbook.crm_push", "runId", run.id);
    if (alreadyEnded(ends, status, attempt)) return { recorded: false };
    await recordWorkbookActivity(tx, actor, run.workbookId, {
      action: "workbook.crm_push",
      channel: "worker",
      after: { runId: run.id, columnId: run.columnId, columnName: column.name, provider, status, ...(status === "interrupted" ? { attempt } : {}), attempted, succeeded, failed, skipped },
    });
    return { recorded: true };
  });
}

export interface ExportReport {
  /** The export's own id: reports about it with the same status are recorded once. */
  exportId: string;
  format: "csv";
  destination: "download" | "email";
  status: ExportStatus;
  /** Rows exported when completed (required); rows requested when started (optional); ignored otherwise. */
  rows?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An export of a workbook (PRD EXP-4). `actor` is the person who asked for it: from the session for a download, from
 * the stored job for a background export. Only a completed export says rows were exported.
 */
export async function recordExport(db: Db, actor: ActivityActor, workbookId: string, report: ExportReport): Promise<Recorded> {
  const { exportId, format, destination, status } = report;
  if (!UUID.test(exportId)) throw invalid("exportId must be a UUID");
  if (format !== "csv") throw invalid("format must be csv");
  if (destination !== "download" && destination !== "email") throw invalid("destination must be download or email");
  if (!EXPORT_STATUSES.includes(status)) throw invalid(`status must be one of ${EXPORT_STATUSES.join(", ")}`);
  if (status === "completed" && !isCount(report.rows)) throw invalid("a completed export says how many rows it exported");
  if (status === "started" && report.rows !== undefined && !isCount(report.rows)) throw invalid("rows must be a whole number of rows");
  const key = exportId.toLowerCase();
  return inTransaction(db, async (tx) => {
    // A deleted workbook is accepted: an export that was under way must still be recorded.
    const [workbook] = await tx.select({ id: workbooks.id }).from(workbooks).where(scopedById(workbooks, actor.workspaceId, workbookId));
    if (!workbook) throw new WorkbookV2Error("NOT_FOUND", 404, "Workbook not found");
    // An export has no row of its own to lock.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workbook-export:${workbook.id}:${key}`}, 0))`);
    const before = await history(tx, actor.workspaceId, workbook.id, "workbook.export", "exportId", key);
    if (before.some((e) => e.status !== "started" || status === "started")) return { recorded: false };
    await recordWorkbookActivity(tx, actor, workbook.id, {
      action: "workbook.export",
      channel: actor.requestId ? "api" : "worker",
      after: { exportId: key, format, destination, status, rows: status === "completed" || status === "started" ? (report.rows ?? null) : null },
    });
    return { recorded: true };
  });
}

// ── Reading ───────────────────────────────────────────────────────────────────

export type ActivityType = (typeof WORKBOOK_ACTIVITY_TYPES)[WorkbookAction];

export interface ActivityEvent {
  id: string;
  type: ActivityType;
  occurredAt: string;
  /** Null when no person did it. */
  actor: { id: string; name: string | null; email: string } | null;
  details: Record<string, unknown>;
}

/** A position in the feed. `at` keeps the database's microseconds, so no event is skipped between pages. */
export interface ActivityCursor {
  at: string;
  id: string;
}

const pick = (source: Stored, keys: string[]) => Object.fromEntries(keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]));
const COLUMN = ["columnId", "columnName"];
const RUN = ["runId", ...COLUMN];

/** Only the named fields of a record ever leave the server. */
function detailsOf(action: WorkbookAction, before: Stored, after: Stored, charged: ReadonlyMap<string, number>): Record<string, unknown> {
  switch (action) {
    case "workbook.rows.added":
      return pick(after, ["source", "rows", "rowCount", "copiedFromWorkbookId", "object", "viewName", "spreadsheetName", "tabName", "pull", "alreadyImported", "status", "duplicates", "skipped", "failed"]);
    case "workbook.rows.delete":
      return { rows: after.deleted, rowCount: after.rowCount };
    case "workbook.column.added":
      return pick(after, [...COLUMN, "columnType", "operation", "copiedFromWorkbookId"]);
    case "workbook.column.updated":
      return pick(after, [...COLUMN, "renamedFrom", "settingsChanged", "dataType"]);
    case "workbook.column.hidden":
    case "workbook.column.shown":
    case "workbook.column.frozen":
    case "workbook.column.unfrozen":
      return pick(after, COLUMN);
    case "workbook.column.resized":
      return pick(after, [...COLUMN, "width"]);
    case "workbook.columns.reordered":
      return pick(after, ["columns"]);
    case "workbook.column.delete":
      return { columnId: before.columnId, columnName: before.name, columnType: before.type, operation: before.operation };
    case "workbook.delete":
      return pick(after, ["name"]);
    case "workbook.restore":
      return {};
    case "workbook.run.started":
      return { ...pick(after, [...RUN, "scope", "rows", "maxCredits"]), actualCredits: null };
    case "workbook.run.finished":
      return { ...pick(after, [...RUN, "status", "rows", "maxCredits"]), actualCredits: charged.get(String(after.runId)) ?? 0 };
    case "workbook.export":
      return pick(after, ["exportId", "format", "destination", "status", "rows"]);
    case "workbook.crm_push":
      return pick(after, [...RUN, "provider", "status", "attempted", "succeeded", "failed", "skipped"]);
  }
}

/** One page of a live workbook's activity, newest first. */
export async function listWorkbookActivity(
  db: Db,
  workspaceId: string,
  workbookId: string,
  page: { limit: number; cursor?: ActivityCursor }
): Promise<{ data: ActivityEvent[]; next: ActivityCursor | null }> {
  const workbook = await findLiveWorkbook(db, workspaceId, workbookId);
  const older: SQL | undefined = page.cursor ? sql`(${auditLogs.createdAt}, ${auditLogs.id}) < (${page.cursor.at}::timestamptz, ${page.cursor.id}::uuid)` : undefined;
  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      createdAt: auditLogs.createdAt,
      exact: sql<string>`to_char(${auditLogs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      before: auditLogs.beforeState,
      after: auditLogs.afterState,
      actorId: users.id,
      actorName: users.fullName,
      actorEmail: users.email,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(
      and(
        eq(auditLogs.workspaceId, workspaceId),
        eq(auditLogs.entityType, WORKBOOK_ENTITY),
        eq(auditLogs.entityId, workbook.id),
        inArray(auditLogs.action, Object.keys(WORKBOOK_ACTIVITY_TYPES)),
        older
      )
    )
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(page.limit + 1);

  const shown = rows.slice(0, page.limit);
  const finishedRuns = shown.filter((r) => r.action === "workbook.run.finished").map((r) => String((r.after as Stored).runId));
  const charged = await chargedCredits(db, workspaceId, workbook.id, [...new Set(finishedRuns)]);
  const last = shown[shown.length - 1];
  return {
    data: shown.map((r) => {
      const action = r.action as WorkbookAction;
      return {
        id: r.id,
        type: WORKBOOK_ACTIVITY_TYPES[action],
        occurredAt: r.createdAt.toISOString(),
        actor: r.actorId ? { id: r.actorId, name: r.actorName, email: r.actorEmail! } : null,
        details: detailsOf(action, (r.before ?? {}) as Stored, (r.after ?? {}) as Stored, charged),
      };
    }),
    next: rows.length > page.limit && last ? { at: last.exact, id: last.id } : null,
  };
}
