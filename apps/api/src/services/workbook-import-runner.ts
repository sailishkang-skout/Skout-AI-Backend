import { open } from "node:fs/promises";
import { and, asc, count, eq, gt, inArray, isNotNull, lt, lte, max, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { createLogger } from "@skout/observability";
import { WorkbookV2Error, getWorkspaceRowLimit, lockLiveWorkbook } from "./workbook-v2.service.js";
import { inputDataType } from "./workbook-cell-values.js";
import { CsvFileError, csvLine, csvRecords, type CsvRecord } from "./workbook-import-csv.js";
import { classifyRow, dedupeValue, duplicateReason, type ClassifiedRow, type ImportPlan, type MatchKey } from "./workbook-import-plan.js";
import { removeStaleTempFiles, reportKey, saveStream, withTempFile, type ImportStorage } from "./workbook-import-storage.js";
import { recordWorkbookActivity } from "./workbook-activity-log.js";

/**
 * Does a confirmed CSV import (WB2-020).
 *
 * The file is worked through in chunks. Each chunk is one transaction that adds its rows, records the rows it did not
 * add, and moves the import's `processed` count past them, so a chunk happens completely or not at all. A retry reads
 * the file again and starts after `processed`: nothing is imported twice. The workbook is locked only for the length
 * of a chunk, so people can keep working in it.
 */
const { workbooks, workbookColumns, workbookRows, workbookCells, workbookImports, workbookImportIssues } = schema;
const log = createLogger("workbook-import");

export const CHUNK_ROWS = 1_000;
/** Wide files use smaller chunks, so a chunk stays a short transaction. */
const CHUNK_CELLS = 20_000;
const MIN_CHUNK_ROWS = 100;
const KEY_PAGE = 20_000;
const REPORT_PAGE = 2_000;

export const UNFINISHED_STATUSES = ["awaiting_confirmation", "queued", "processing"] as const;
const FINISHED = new Set<string>(["completed", "failed", "cancelled"]);

export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
export const REQUEUE_AFTER_MS = 10 * 60 * 1000;
export const GIVE_UP_AFTER_MS = 6 * 60 * 60 * 1000;
const STALE_TEMP_AFTER_MS = 2 * 60 * 60 * 1000;

export const IMPORT_FAILED_MESSAGE =
  "The import stopped because of a problem on our side. Rows already imported are in the workbook. To add the rest, upload the file again and choose a deduplication key so rows are not added twice.";

export interface ImportCounts {
  total: number;
  processed: number;
  imported: number;
  duplicates: number;
  skipped: number;
  failed: number;
}

export function countsOf(stored: Record<string, number> | null | undefined): ImportCounts {
  const n = (key: keyof ImportCounts) => stored?.[key] ?? 0;
  return { total: n("total"), processed: n("processed"), imported: n("imported"), duplicates: n("duplicates"), skipped: n("skipped"), failed: n("failed") };
}

export interface ImportJob {
  importId: string;
  workspaceId: string;
}

export interface ImportQueue {
  /** Whether background work can be queued right now. */
  ready(): Promise<boolean>;
  enqueue(job: ImportJob): Promise<void>;
}

/**
 * What may be logged about a failure: its kind and code only. A database error's own text quotes the statement and its
 * values, which here are the rows of someone's file, and a file error's text names where files are kept.
 */
export function describeFailure(error: unknown): string {
  const e = (error ?? {}) as { name?: unknown; code?: unknown; cause?: { code?: unknown; constraint_name?: unknown } };
  return [e.name, e.cause?.code ?? e.code, e.cause?.constraint_name].filter((part) => typeof part === "string" && part).join(" ") || "unknown error";
}

/** An unexpected failure with nothing from the original error but what `describeFailure` allows. */
export class ImportFailure extends Error {
  readonly code?: string;
  constructor(what: string, error: unknown) {
    super(`${what} (${describeFailure(error)})`);
    this.name = "ImportFailure";
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string") this.code = code;
  }
}

/** Something retrying cannot fix. */
class ImportStopped extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ImportStopped";
  }
}

/** Another worker moved this import on, or it finished: this attempt has nothing left to do. */
class Superseded extends Error {}

async function loadImport(db: Db, importId: string) {
  const [found] = await db
    .select({ record: workbookImports, workspaceId: workbooks.workspaceId })
    .from(workbookImports)
    .innerJoin(workbooks, eq(workbooks.id, workbookImports.workbookId))
    .where(and(eq(workbookImports.id, importId), eq(workbookImports.sourceType, "csv")))
    .limit(1);
  return found ?? null;
}

const lockImport = async (tx: Db, importId: string) => (await tx.select().from(workbookImports).where(eq(workbookImports.id, importId)).limit(1).for("no key update"))[0];

/** The deduplication values already in the key column, brought up to date with rows added since the last look. */
class KeyIndex {
  private readonly values = new Set<string>();
  private upToRowId = 0;

  constructor(
    private readonly workbookId: string,
    private readonly columnId: string,
    private readonly key: MatchKey
  ) {}

  has = (value: string) => this.values.has(value);
  add = (value: string) => this.values.add(value);

  async refresh(db: Db): Promise<void> {
    const [latest] = await db.select({ id: max(workbookRows.id) }).from(workbookRows).where(eq(workbookRows.workbookId, this.workbookId));
    const upTo = Number(latest?.id ?? 0);
    let after = this.upToRowId;
    while (after < upTo) {
      const cells = await db
        .select({ rowId: workbookCells.rowId, value: workbookCells.value })
        .from(workbookCells)
        .where(and(eq(workbookCells.workbookId, this.workbookId), eq(workbookCells.columnId, this.columnId), gt(workbookCells.rowId, after), lte(workbookCells.rowId, upTo)))
        .orderBy(asc(workbookCells.rowId))
        .limit(KEY_PAGE);
      for (const cell of cells) {
        const value = dedupeValue(this.key, String(cell.value ?? ""));
        if (value !== null) this.values.add(value);
      }
      if (cells.length < KEY_PAGE) break;
      after = cells[cells.length - 1]!.rowId;
    }
    this.upToRowId = Math.max(this.upToRowId, upTo);
  }
}

interface Run {
  importId: string;
  workspaceId: string;
  workbookId: string;
  plan: ImportPlan;
  /** Stored on every imported row (PRD ROW-9). */
  source: string;
  keys: KeyIndex | null;
}

type Pending = CsvRecord & { record: number };
type Issue = { record: number; line: number; kind: (typeof schema.WORKBOOK_IMPORT_ISSUE_KINDS)[number]; reason: string; values: string[] };

async function checkColumns(tx: Db, run: Run) {
  const found = await tx
    .select({ id: workbookColumns.id, type: workbookColumns.type, config: workbookColumns.config })
    .from(workbookColumns)
    .where(and(eq(workbookColumns.workbookId, run.workbookId), inArray(workbookColumns.id, run.plan.columns.map((c) => c.columnId))));
  const byId = new Map(found.map((c) => [c.id, c]));
  for (const planned of run.plan.columns) {
    const column = byId.get(planned.columnId);
    if (!column || column.type !== "input" || inputDataType(column.config) !== planned.dataType) {
      throw new ImportStopped("MAPPING_CHANGED", `The column “${planned.name}” was deleted or its type changed while the import was running. Rows already imported are in the workbook.`);
    }
  }
}

async function importChunk(db: Db, run: Run, chunk: Pending[]): Promise<void> {
  const newKeys = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const current = await lockImport(tx, run.importId);
    const counts = countsOf(current?.counts);
    if (current?.status !== "processing" || counts.processed !== chunk[0]!.record - 1) throw new Superseded();
    try {
      await lockLiveWorkbook(tx, run.workspaceId, run.workbookId);
    } catch (error) {
      if (error instanceof WorkbookV2Error && error.code === "NOT_FOUND") throw new ImportStopped("WORKBOOK_DELETED", "The workbook was deleted while the import was running.");
      throw error;
    }
    await checkColumns(tx, run);
    // Under the lock, so rows added by anyone else since the last chunk are counted as existing.
    await run.keys?.refresh(tx);

    const limit = await getWorkspaceRowLimit(tx, run.workspaceId);
    const [rows] = await tx.select({ n: count() }).from(workbookRows).where(eq(workbookRows.workbookId, run.workbookId));
    const existing = rows?.n ?? 0;

    const accepted: Array<Extract<ClassifiedRow, { kind: "ready" }>> = [];
    const issues: Issue[] = [];
    const keys = new Set<string>();
    for (const row of chunk) {
      const outcome = classifyRow(run.plan, row.values);
      const report = (kind: Issue["kind"], reason: string) => issues.push({ record: row.record, line: row.line, kind, reason, values: row.values });
      if (outcome.kind !== "ready") report(outcome.kind, outcome.reason);
      else if (outcome.key !== null && (keys.has(outcome.key) || run.keys!.has(outcome.key))) report("duplicate", duplicateReason((run.plan.dedupe as { key: MatchKey }).key));
      else if (existing + accepted.length >= limit) report("over_limit", `The workbook reached its limit of ${limit.toLocaleString("en-US")} rows`);
      else {
        accepted.push(outcome);
        if (outcome.key !== null) keys.add(outcome.key);
      }
    }

    if (accepted.length) {
      const [last] = await tx.select({ position: max(workbookRows.position) }).from(workbookRows).where(eq(workbookRows.workbookId, run.workbookId));
      const first = (last?.position ?? -1) + 1;
      const inserted = (await tx.execute(sql`
        INSERT INTO workbook_rows (workbook_id, position, source)
        SELECT ${run.workbookId}::uuid, p, ${run.source}::text::jsonb FROM generate_series(${first}::int, ${first + accepted.length - 1}::int) AS p
        RETURNING id, position`)) as unknown as Array<{ id: string | number; position: number }>;
      // Matched by position, which is unique within this chunk; the order of RETURNING is not relied on.
      const idAt = new Map(inserted.map((r) => [Number(r.position), Number(r.id)]));
      const cells = accepted.flatMap((row, i) => row.cells.map((cell) => ({ r: idAt.get(first + i)!, c: cell.columnId, v: cell.value })));
      for (let i = 0; i < cells.length; i += CHUNK_CELLS) {
        await tx.execute(sql`
          INSERT INTO workbook_cells (workbook_id, row_id, column_id, value, state)
          SELECT ${run.workbookId}::uuid, x.r, x.c, x.v, 'found'
          FROM jsonb_to_recordset(${JSON.stringify(cells.slice(i, i + CHUNK_CELLS))}::text::jsonb) AS x (r bigint, c uuid, v jsonb)`);
      }
      await tx.update(workbooks).set({ rowCount: existing + accepted.length, updatedAt: sql`now()` }).where(eq(workbooks.id, run.workbookId));
    }
    if (issues.length) {
      await tx.execute(sql`
        INSERT INTO workbook_import_issues (import_id, record, line, kind, reason, "values")
        SELECT ${run.importId}::uuid, x.record, x.line, x.kind, x.reason, x."values"
        FROM jsonb_to_recordset(${JSON.stringify(issues)}::text::jsonb) AS x (record int, line int, kind text, reason text, "values" jsonb)`);
    }

    const duplicates = issues.filter((i) => i.kind === "duplicate").length;
    const skipped = issues.filter((i) => i.kind === "skipped").length;
    const next: ImportCounts = {
      total: counts.total,
      processed: counts.processed + chunk.length,
      imported: counts.imported + accepted.length,
      duplicates: counts.duplicates + duplicates,
      skipped: counts.skipped + skipped,
      failed: counts.failed + issues.length - duplicates - skipped,
    };
    await tx.update(workbookImports).set({ counts: { ...next }, updatedAt: sql`now()` }).where(eq(workbookImports.id, run.importId));
    return keys;
  });
  for (const key of newKeys) run.keys?.add(key);
}

/** The queued import, marked as being worked on. Null when there is nothing to do. */
async function claim(db: Db, importId: string) {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const record = await lockImport(tx, importId);
    if (!record || (record.status !== "queued" && record.status !== "processing")) return null;
    await tx.update(workbookImports).set({ status: "processing", updatedAt: sql`now()` }).where(eq(workbookImports.id, importId));
    return record;
  });
}

/**
 * Works through a confirmed import and finishes it. Safe to call again at any point. Throws only for problems worth
 * retrying; anything else ends the import as failed.
 */
export async function processImport(db: Db, storage: ImportStorage, importId: string): Promise<void> {
  try {
    await attemptImport(db, storage, importId);
  } catch (error) {
    throw new ImportFailure(`Import ${importId} could not be processed`, error);
  }
}

async function attemptImport(db: Db, storage: ImportStorage, importId: string): Promise<void> {
  const found = await loadImport(db, importId);
  if (!found) return;
  if (FINISHED.has(found.record.status)) return housekeepImport(db, storage, importId);
  const record = await claim(db, importId);
  if (!record) return;

  const plan = record.plan as unknown as ImportPlan;
  const run: Run = {
    importId,
    workspaceId: found.workspaceId,
    workbookId: record.workbookId,
    plan,
    source: JSON.stringify({ type: "csv", fileName: record.fileName, importId, importedAt: (record.confirmedAt ?? record.createdAt).toISOString() }),
    keys: plan.dedupe.key === "none" ? null : new KeyIndex(record.workbookId, plan.dedupe.columnId, plan.dedupe.key),
  };
  const done = countsOf(record.counts).processed;
  const size = Math.max(MIN_CHUNK_ROWS, Math.min(CHUNK_ROWS, Math.floor(CHUNK_CELLS / plan.columns.length)));

  try {
    await withTempFile(async (file) => {
      const stored = record.fileKey ? await storage.open(record.fileKey) : null;
      if (!stored) throw new ImportStopped("FILE_MISSING", "The uploaded file is no longer available. Upload it again.");
      await saveStream(stored, file);
      // The long first read happens before any lock is taken.
      await run.keys?.refresh(db);
      let chunk: Pending[] = [];
      let n = -1; // The header line is record 0.
      for await (const row of csvRecords(file, plan.delimiter)) {
        n += 1;
        if (n === 0 || n <= done) continue;
        chunk.push({ ...row, record: n });
        if (chunk.length === size) {
          await importChunk(db, run, chunk);
          chunk = [];
        }
      }
      if (chunk.length) await importChunk(db, run, chunk);
    });
  } catch (error) {
    if (error instanceof Superseded) return;
    if (error instanceof ImportStopped) return finishImport(db, storage, importId, { status: "failed", code: error.code, message: error.message });
    // The file was checked when it was uploaded, so this is the stored copy being damaged.
    if (error instanceof CsvFileError) return finishImport(db, storage, importId, { status: "failed", code: "FILE_UNREADABLE", message: error.message });
    throw error;
  }
  await finishImport(db, storage, importId, { status: "completed" });
}

/** One attempt by the background worker. After the last one the import is marked failed. */
export async function runImportJob(db: Db, storage: ImportStorage, importId: string, lastAttempt: boolean): Promise<void> {
  try {
    await processImport(db, storage, importId);
  } catch (error) {
    if (lastAttempt) {
      await finishImport(db, storage, importId, { status: "failed", code: "IMPORT_FAILED", message: IMPORT_FAILED_MESSAGE }).catch((failure) =>
        // The sweep ends it later.
        log.error("could not mark an import failed", undefined, { importId, failure: describeFailure(failure) })
      );
    }
    throw error;
  }
}

const RESULT_LABEL: Record<Issue["kind"], string> = {
  duplicate: "Duplicate",
  invalid: "Invalid value",
  malformed: "Malformed row",
  skipped: "Skipped",
  over_limit: "Over the row limit",
};

/**
 * Writes the downloadable report from the recorded issues, stores it and notes it on the import. False when there is
 * nothing to report. The issues are removed only by the caller, once the report is safely stored.
 */
async function writeReport(db: Db, storage: ImportStorage, workspaceId: string, importId: string, headers: string[]): Promise<boolean> {
  const [any] = await db.select({ record: workbookImportIssues.record }).from(workbookImportIssues).where(eq(workbookImportIssues.importId, importId)).limit(1);
  if (!any) return false;
  const key = reportKey(workspaceId, importId);
  await withTempFile(async (file) => {
    const out = await open(file, "w", 0o600);
    try {
      // A byte-order mark makes spreadsheet programs read the file as UTF-8.
      await out.write(`\uFEFF${csvLine(["Line in file", "Result", "Reason", ...headers])}`);
      let after = 0;
      for (;;) {
        const page = await db
          .select()
          .from(workbookImportIssues)
          .where(and(eq(workbookImportIssues.importId, importId), gt(workbookImportIssues.record, after)))
          .orderBy(asc(workbookImportIssues.record))
          .limit(REPORT_PAGE);
        if (page.length) await out.write(page.map((i) => csvLine([String(i.line), RESULT_LABEL[i.kind], i.reason, ...i.values])).join(""));
        if (page.length < REPORT_PAGE) break;
        after = page[page.length - 1]!.record;
      }
    } finally {
      await out.close();
    }
    await storage.put(key, file);
  });
  await db.update(workbookImports).set({ errorReportFile: key }).where(eq(workbookImports.id, importId));
  return true;
}

export type ImportOutcome = { status: "completed" } | { status: "failed"; code: string; message: string };

/**
 * Ends an import once: writes the report, records the rows added in the activity log, then removes the uploaded file.
 * The first outcome stands.
 */
export async function finishImport(db: Db, storage: ImportStorage, importId: string, outcome: ImportOutcome): Promise<void> {
  const found = await loadImport(db, importId);
  if (!found) return;
  if (!FINISHED.has(found.record.status)) {
    const headers = (found.record.plan as unknown as ImportPlan | null)?.headers ?? [];
    const reportedUpTo = countsOf(found.record.counts).processed;
    let reported = false;
    try {
      reported = await writeReport(db, storage, found.workspaceId, importId, headers);
    } catch (error) {
      // A completed import comes with its report, so try the whole step again. A failure is recorded regardless; the
      // sweep writes its report later.
      if (outcome.status === "completed") throw error;
      log.error("could not write the import report", undefined, { importId, failure: describeFailure(error) });
    }
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const record = await lockImport(tx, importId);
      if (!record || FINISHED.has(record.status)) return;
      // A chunk landed while the report was being written: whoever is still working on it will finish it.
      if (countsOf(record.counts).processed !== reportedUpTo) return;
      await tx
        .update(workbookImports)
        .set({
          status: outcome.status,
          error: outcome.status === "failed" ? { code: outcome.code, message: outcome.message } : null,
          preview: null,
          finishedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(workbookImports.id, importId));
      if (reported) await tx.delete(workbookImportIssues).where(eq(workbookImportIssues.importId, importId));
      const added = countsOf(record.counts).imported;
      if (added > 0) {
        const [workbook] = await tx.select({ rowCount: workbooks.rowCount }).from(workbooks).where(eq(workbooks.id, record.workbookId));
        const requestId = (record.plan as unknown as ImportPlan | null)?.requestId ?? undefined;
        await recordWorkbookActivity(tx, { workspaceId: found.workspaceId, userId: record.createdBy, requestId }, record.workbookId, {
          action: "workbook.rows.added",
          after: { source: "csv", rows: added, rowCount: workbook?.rowCount ?? added },
          channel: "worker",
        });
      }
    });
  }
  await housekeepImport(db, storage, importId);
}

/**
 * What a finished import may still owe: its report, and the removal of the uploaded file. Failures are logged and left
 * for the sweep.
 */
export async function housekeepImport(db: Db, storage: ImportStorage, importId: string): Promise<void> {
  const found = await loadImport(db, importId);
  if (!found || !FINISHED.has(found.record.status)) return;
  try {
    const headers = (found.record.plan as unknown as ImportPlan | null)?.headers ?? [];
    if (await writeReport(db, storage, found.workspaceId, importId, headers)) await db.delete(workbookImportIssues).where(eq(workbookImportIssues.importId, importId));
  } catch (error) {
    log.error("could not write the import report", undefined, { importId, failure: describeFailure(error) });
  }
  if (!found.record.fileKey) return;
  try {
    await storage.remove(found.record.fileKey);
    await db.update(workbookImports).set({ fileKey: null }).where(eq(workbookImports.id, importId));
  } catch (error) {
    log.error("could not remove an uploaded import file", undefined, { importId, failure: describeFailure(error) });
  }
}

export interface SweepResult {
  expired: number;
  requeued: number;
  gaveUp: number;
  cleaned: number;
}

/**
 * Looks after imports nothing else will: ones never confirmed, ones whose background job was lost, and finished ones
 * that still hold a file.
 */
export async function sweepImports(db: Db, storage: ImportStorage, queue: ImportQueue, now = new Date()): Promise<SweepResult> {
  const before = (ms: number) => new Date(now.getTime() - ms);
  const expired = await db
    .update(workbookImports)
    .set({
      status: "cancelled",
      error: { code: "EXPIRED", message: "The import was not confirmed within 24 hours, so the file was removed. Upload it again." },
      preview: null,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(workbookImports.sourceType, "csv"), eq(workbookImports.status, "awaiting_confirmation"), lt(workbookImports.createdAt, before(ABANDONED_AFTER_MS))))
    .returning({ id: workbookImports.id });

  const stalled = await db
    .select({ id: workbookImports.id, confirmedAt: workbookImports.confirmedAt, workspaceId: workbooks.workspaceId })
    .from(workbookImports)
    .innerJoin(workbooks, eq(workbooks.id, workbookImports.workbookId))
    .where(and(eq(workbookImports.sourceType, "csv"), inArray(workbookImports.status, ["queued", "processing"]), lt(workbookImports.updatedAt, before(REQUEUE_AFTER_MS))));
  let requeued = 0;
  let gaveUp = 0;
  for (const item of stalled) {
    try {
      if (item.confirmedAt && item.confirmedAt < before(GIVE_UP_AFTER_MS)) {
        await finishImport(db, storage, item.id, { status: "failed", code: "IMPORT_STALLED", message: IMPORT_FAILED_MESSAGE });
        gaveUp += 1;
      } else {
        await queue.enqueue({ importId: item.id, workspaceId: item.workspaceId });
        requeued += 1;
      }
    } catch (error) {
      log.error("could not recover a stalled import", undefined, { importId: item.id, failure: describeFailure(error) });
    }
  }

  const finished = and(eq(workbookImports.sourceType, "csv"), isNotNull(workbookImports.finishedAt));
  const holdingFile = await db.select({ id: workbookImports.id }).from(workbookImports).where(and(finished, isNotNull(workbookImports.fileKey)));
  // Issues are removed when a report is written, so any left on a finished import still need one.
  const unreported = await db
    .selectDistinct({ id: workbookImports.id })
    .from(workbookImportIssues)
    .innerJoin(workbookImports, eq(workbookImports.id, workbookImportIssues.importId))
    .where(finished);
  const leftovers = [...new Set([...holdingFile, ...unreported].map((item) => item.id))];
  for (const id of leftovers) await housekeepImport(db, storage, id);

  await removeStaleTempFiles(STALE_TEMP_AFTER_MS);
  return { expired: expired.length, requeued, gaveUp, cleaned: leftovers.length };
}
