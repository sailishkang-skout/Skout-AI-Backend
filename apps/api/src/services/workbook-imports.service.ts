import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { createLogger } from "@skout/observability";
import { WorkbookV2Error, findLiveWorkbook, getWorkspaceRowLimit, lockLiveWorkbook, type WorkbookActor } from "./workbook-v2.service.js";
import { MAX_COLUMNS, addColumn } from "./workbook-v2-columns.service.js";
import { inputDataType } from "./workbook-cell-values.js";
import { CsvFileError, MAX_IMPORT_BYTES, inspectCsv, type CsvDelimiter, type CsvInspection } from "./workbook-import-csv.js";
import { checkMapping, suggestMapping, type ColumnMapping, type DedupeChoice, type ExistingColumn, type HeaderSuggestion, type ImportPlan, type MatchKey, type PlannedColumn } from "./workbook-import-plan.js";
import { UploadTooLarge, receiveUpload, uploadKey, withTempFile, type ImportStorage } from "./workbook-import-storage.js";
import { IMPORT_SOURCE_TYPES, RetryLater, isCrmSource, isFileSource, isRecordSource } from "./workbook-import-core.js";
import type { SheetImportPlan } from "./workbook-sheet-runner.js";
import type { SheetsReader } from "./workbook-sheets-access.js";
import { checkSheetConfirm, linkSheetSource, type SheetPreview } from "./workbook-sheet-confirm.js";
import type { CrmAccess } from "./workbook-crm-access.js";
import type { CrmImportPlan } from "./workbook-crm-runner.js";
import type { CrmPlan } from "./workbook-crm.service.js";
import type { ProspectPlan } from "./workbook-prospect-runner.js";
import type { ProspectDirectory } from "./prospect-directory.js";
import { ImportFailure, UNFINISHED_STATUSES, countsOf, describeFailure, failedMessage, finishImport, housekeepImport, processImport, type ImportCounts, type ImportQueue } from "./workbook-import-runner.js";

/**
 * CSV import for Workbooks V2 (WB2-020): upload and check a file, confirm how its columns map, follow progress and
 * download the report of rows that were not imported. Nothing is added to a workbook until an import is confirmed.
 *
 * Every function takes the workspace from the session and reaches an import through that workspace's live workbook.
 * What is returned never includes where a file is stored.
 */
const { workbooks, workbookColumns, workbookRows, workbookImports } = schema;
const log = createLogger("workbook-import");

/** Imports with more rows than this run in the background. */
export const SYNC_ROW_LIMIT = 1_000;
export const MAX_UNFINISHED_IMPORTS = 10;
export const LISTED_IMPORTS = 20;
const MAX_FILE_NAME = 255;
const COLUMN_NAME_MAX = 200;

/** What browsers and tools call a CSV file. The content is checked whatever the sender says. */
const CONTENT_TYPES = new Set(["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream"]);

type ImportRecord = typeof workbookImports.$inferSelect;

interface StoredPreview {
  delimiter: CsvDelimiter;
  headers: CsvInspection["headers"];
  rows: CsvInspection["preview"];
  suggestions: HeaderSuggestion[];
  /** Google Sheets only. */
  sheet?: SheetPreview;
}

export interface ImportDto {
  id: string;
  workbookId: string;
  /** csv, list, smart_list, search, google_sheets, a CRM or apollo. */
  sourceType: string;
  /** The list, smart list, CRM view, Apollo list or sheet tab rows came from. */
  sourceName: string | null;
  /** For a Google Sheets import, the tab being read. */
  sheet: { sourceId: string | null; spreadsheetName: string; tabName: string; pull: boolean } | null;
  /** For a CRM import, what is being read. */
  crm: { provider: string; object: "contact" | "company" } | null;
  /**
   * Set when only the first of what matched were considered: the workbook cannot hold more, or (`source_limit`) the
   * source will not be read further.
   */
  truncated: { matched: number; considered: number; reason?: "source_limit" } | null;
  status: string;
  fileName: string;
  fileBytes: number;
  counts: ImportCounts;
  /** 0 to 100: the share of the file's rows dealt with so far. */
  progress: number;
  /** Whether this many rows are imported in the background. */
  background: boolean;
  error: { code: string; message: string } | null;
  report: { available: boolean; rows: number };
  /** Only while awaiting confirmation. A sheet's preview is shown only to whoever asked for it. */
  preview: StoredPreview | null;
  /** Only once confirmed. */
  mapping: { columns: Array<{ header: number; headerName: string; columnId: string; columnName: string }>; dedupe: { key: string; header?: number } } | null;
  createdAt: string;
  confirmedAt: string | null;
  finishedAt: string | null;
}

export function toImportDto(record: ImportRecord, opts: { preview?: boolean; viewerId?: string | null } = {}): ImportDto {
  const sheet = record.sourceType === "google_sheets" ? ((record.plan as unknown as SheetImportPlan | null)?.sheet ?? null) : null;
  // What a sheet holds was read through one person's Google account; until they add it, only they see it.
  const shown = opts.preview && record.status === "awaiting_confirmation" && (record.sourceType !== "google_sheets" || record.createdBy === opts.viewerId);
  const counts = countsOf(record.counts);
  // What was read from a CRM or Apollo, a page at a time.
  const read = isRecordSource(record.sourceType) ? ((record.plan as unknown as { crm?: CrmPlan } | null)?.crm ?? null) : null;
  // Only imports with columns to map have a mapping: files, and CRM or Apollo selections once confirmed.
  // A pull has its mapping once it has read the tab.
  const mapped = record.sourceType === "csv" || ((read !== null || sheet !== null) && record.confirmedAt !== null);
  const plan = mapped ? (record.plan as unknown as ImportPlan | null) : null;
  const addition = isFileSource(record.sourceType) || isRecordSource(record.sourceType) ? null : (record.plan as unknown as ProspectPlan | null);
  const progress = record.status === "completed" ? 100 : counts.total ? Math.floor((counts.processed * 100) / counts.total) : 0;
  return {
    id: record.id,
    workbookId: record.workbookId,
    sourceType: record.sourceType,
    sourceName: addition?.source.name ?? read?.viewName ?? sheet?.tabName ?? null,
    sheet: sheet ? { sourceId: record.sheetSourceId, spreadsheetName: sheet.spreadsheetName, tabName: sheet.tabName, pull: sheet.pull } : null,
    crm: read && isCrmSource(record.sourceType) ? { provider: read.provider, object: read.object } : null,
    truncated: addition?.truncated ?? read?.truncated ?? null,
    status: record.status,
    fileName: record.fileName ?? "",
    fileBytes: record.fileBytes ?? 0,
    counts,
    progress,
    background: addition ? addition.background : (read?.background ?? sheet?.background ?? counts.total > SYNC_ROW_LIMIT),
    error: record.error,
    report: { available: record.errorReportFile !== null, rows: counts.duplicates + counts.skipped + counts.failed },
    preview: shown ? (record.preview as unknown as StoredPreview | null) : null,
    mapping: plan?.columns
      ? {
          columns: plan.columns.map((c) => ({ header: c.header, headerName: plan.headers[c.header] ?? "", columnId: c.columnId, columnName: c.name })),
          dedupe: plan.dedupe.key === "none" ? { key: "none" } : { key: plan.dedupe.key, header: plan.dedupe.header },
        }
      : null,
    createdAt: record.createdAt.toISOString(),
    confirmedAt: record.confirmedAt?.toISOString() ?? null,
    finishedAt: record.finishedAt?.toISOString() ?? null,
  };
}

/** Expected refusals pass through; anything else loses the text that could quote the file or name where it is kept. */
async function withoutFileDetails<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof WorkbookV2Error) throw error;
    throw new ImportFailure(what, error);
  }
}

const anyImport = inArray(workbookImports.sourceType, [...IMPORT_SOURCE_TYPES]);

const importNotFound = () => new WorkbookV2Error("NOT_FOUND", 404, "Import not found");

const stateConflict = (status: string) =>
  new WorkbookV2Error("IMPORT_STATE_CONFLICT", 409, `This import is ${status.replaceAll("_", " ")}, so it cannot be changed.`, { status });

async function columnsOf(db: Db, workbookId: string): Promise<ExistingColumn[]> {
  const rows = await db
    .select({ id: workbookColumns.id, name: workbookColumns.name, type: workbookColumns.type, config: workbookColumns.config })
    .from(workbookColumns)
    .where(eq(workbookColumns.workbookId, workbookId))
    .orderBy(asc(workbookColumns.position), asc(workbookColumns.id));
  return rows.map((c) => ({ id: c.id, name: c.name, type: c.type, dataType: inputDataType(c.config) }));
}

/** The file's name without any folders or control characters. */
function cleanFileName(raw: string | null): string | null {
  const name = (raw ?? "")
    .split(/[/\\]/)
    .pop()!
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  return name && name.length <= MAX_FILE_NAME ? name : null;
}

const tooLarge = () => new WorkbookV2Error("FILE_TOO_LARGE", 413, `The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB. Split it into smaller files.`, { limitBytes: MAX_IMPORT_BYTES });

export async function assertRoomForAnotherImport(db: Db, workspaceId: string): Promise<void> {
  const [pending] = await db
    .select({ n: count() })
    .from(workbookImports)
    .innerJoin(workbooks, eq(workbooks.id, workbookImports.workbookId))
    .where(and(eq(workbooks.workspaceId, workspaceId), anyImport, inArray(workbookImports.status, [...UNFINISHED_STATUSES])));
  if ((pending?.n ?? 0) >= MAX_UNFINISHED_IMPORTS) {
    throw new WorkbookV2Error("TOO_MANY_PENDING_IMPORTS", 429, `This workspace already has ${MAX_UNFINISHED_IMPORTS} unfinished imports. Confirm or cancel one, or wait for one to finish.`);
  }
}

/** Runs a confirmed import now, or queues it when it is large. */
export async function startImport(
  db: Db,
  deps: { storage: ImportStorage; queue: ImportQueue; directory?: ProspectDirectory; crm?: CrmAccess; sheets?: SheetsReader },
  job: { importId: string; workspaceId: string },
  background: boolean
): Promise<void> {
  const { importId } = job;
  if (background) {
    // Confirmed either way: if queueing fails now, the sweep queues it.
    await deps.queue.enqueue(job).catch((error) => log.error("could not queue an import", undefined, { importId, failure: describeFailure(error) }));
    return;
  }
  try {
    await processImport(db, deps.storage, importId, deps.directory, deps.crm, deps.sheets);
  } catch (error) {
    if (error instanceof RetryLater) {
      // Carry on in the background, where there is time to wait.
      if (await deps.queue.ready()) return startImport(db, deps, job, true);
      await finishImport(db, deps.storage, importId, { status: "failed", code: error.code, message: error.userMessage });
      return;
    }
    log.error("import failed", undefined, { importId, failure: describeFailure(error) });
    const [record] = await db.select({ sourceType: workbookImports.sourceType }).from(workbookImports).where(eq(workbookImports.id, importId)).limit(1);
    await finishImport(db, deps.storage, importId, { status: "failed", code: "IMPORT_FAILED", message: failedMessage(record?.sourceType ?? "csv") });
  }
}

export interface UploadedFile {
  name: string | null;
  contentType: string | null;
  contentLength: number | null;
  body: Readable | null;
}

async function requireImport(db: Db, workspaceId: string, workbookId: string, importId: string): Promise<ImportRecord> {
  await findLiveWorkbook(db, workspaceId, workbookId);
  const [record] = await db
    .select()
    .from(workbookImports)
    .where(and(eq(workbookImports.id, importId), eq(workbookImports.workbookId, workbookId), anyImport))
    .limit(1);
  if (!record) throw importNotFound();
  return record;
}

/** Takes an uploaded file, checks all of it, and keeps it with a preview until the import is confirmed. */
export async function createImport(db: Db, storage: ImportStorage, actor: WorkbookActor, workbookId: string, file: UploadedFile): Promise<ImportDto> {
  await findLiveWorkbook(db, actor.workspaceId, workbookId);
  const fileName = cleanFileName(file.name);
  if (!fileName) throw new WorkbookV2Error("UNSUPPORTED_FILE_TYPE", 415, `Send the file's name (up to ${MAX_FILE_NAME} characters) in the X-File-Name header.`);
  const contentType = (file.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (!/\.csv$/i.test(fileName) || !CONTENT_TYPES.has(contentType)) {
    throw new WorkbookV2Error("UNSUPPORTED_FILE_TYPE", 415, "Only CSV files can be imported. Upload a file ending in .csv.");
  }
  if (file.contentLength !== null && file.contentLength > MAX_IMPORT_BYTES) throw tooLarge();

  await assertRoomForAnotherImport(db, actor.workspaceId);

  return withoutFileDetails("Could not take an uploaded file", () => withTempFile(async (temp) => {
    let bytes = 0;
    if (file.body) {
      try {
        bytes = await receiveUpload(file.body, temp, MAX_IMPORT_BYTES);
      } catch (error) {
        if (error instanceof UploadTooLarge) throw tooLarge();
        throw new WorkbookV2Error("UPLOAD_INTERRUPTED", 400, "The upload did not finish. Try again.");
      }
    }
    if (!bytes) throw new WorkbookV2Error("INVALID_CSV", 422, "The file is empty.", { reason: "EMPTY_FILE" });

    let inspection: CsvInspection;
    try {
      inspection = await inspectCsv(temp);
    } catch (error) {
      if (!(error instanceof CsvFileError)) throw error;
      throw new WorkbookV2Error(error.reason === "TOO_MANY_ROWS" ? "TOO_MANY_ROWS" : "INVALID_CSV", 422, error.message, {
        reason: error.reason,
        ...(error.line === undefined ? {} : { line: error.line }),
      });
    }

    const id = randomUUID();
    const preview: StoredPreview = {
      delimiter: inspection.delimiter,
      headers: inspection.headers,
      rows: inspection.preview,
      suggestions: suggestMapping(inspection.headers, await columnsOf(db, workbookId), MAX_COLUMNS, COLUMN_NAME_MAX),
    };
    const key = uploadKey(actor.workspaceId, id);
    await storage.put(key, temp);
    try {
      const [record] = await db
        .insert(workbookImports)
        .values({
          id,
          workbookId,
          sourceType: "csv",
          status: "awaiting_confirmation",
          createdBy: actor.userId,
          fileName,
          fileBytes: bytes,
          fileKey: key,
          preview: preview as unknown as Record<string, unknown>,
          counts: { total: inspection.totalRows, processed: 0, imported: 0, duplicates: 0, skipped: 0, failed: 0 },
        })
        .returning();
      return toImportDto(record!, { preview: true });
    } catch (error) {
      await storage.remove(key).catch((e) => log.error("could not remove an uploaded import file", undefined, { importId: id, failure: describeFailure(e) }));
      throw error;
    }
  }));
}

export async function getImport(db: Db, workspaceId: string, workbookId: string, importId: string, viewerId?: string | null): Promise<ImportDto> {
  return toImportDto(await requireImport(db, workspaceId, workbookId, importId), { preview: true, viewerId });
}

/** The workbook's latest imports, newest first, without previews. */
export async function listImports(db: Db, workspaceId: string, workbookId: string): Promise<ImportDto[]> {
  await findLiveWorkbook(db, workspaceId, workbookId);
  const records = await db
    .select()
    .from(workbookImports)
    .where(and(eq(workbookImports.workbookId, workbookId), anyImport))
    .orderBy(desc(workbookImports.createdAt), desc(workbookImports.id))
    .limit(LISTED_IMPORTS);
  return records.map((record) => toImportDto(record));
}

export interface ImportChoice {
  columns: ColumnMapping[];
  dedupe: DedupeChoice;
  /** Google Sheets only: the heading position of the column that identifies rows, or null to go by their contents. */
  idColumn?: number | null;
}

/**
 * Starts an import with the chosen mapping: creates any new columns and then either imports right away (up to 1,000
 * rows) or queues it. A refused mapping changes nothing.
 */
export async function confirmImport(
  db: Db,
  deps: { storage: ImportStorage; queue: ImportQueue; crm?: CrmAccess; sheets?: SheetsReader },
  actor: WorkbookActor,
  workbookId: string,
  importId: string,
  choice: ImportChoice,
  /** Runs before a CRM or Apollo import starts: that the workspace may still read it. */
  checkCrm?: (plan: CrmPlan) => Promise<void>
): Promise<{ background: boolean; data: ImportDto }> {
  const waiting = await requireImport(db, actor.workspaceId, workbookId, importId);
  if (waiting.status !== "awaiting_confirmation") throw stateConflict(waiting.status);
  const crm = isRecordSource(waiting.sourceType) ? (waiting.plan as unknown as { crm: CrmPlan }).crm : null;
  if (crm) await checkCrm?.(crm);
  const fromSheet = waiting.sourceType === "google_sheets";
  if (!fromSheet && choice.idColumn !== undefined) {
    throw new WorkbookV2Error("INVALID_IMPORT_MAPPING", 422, "Only a Google Sheets import has a column that identifies rows.", { errors: [{ path: "idColumn", code: "DEDUPE_COLUMN_INVALID", message: "Only a Google Sheets import has a column that identifies rows." }] });
  }
  if (fromSheet) await checkSheetConfirm(db, deps.sheets!, actor, waiting);
  // A selection the CRM would not count could be any size.
  const background = (crm !== null && crm.matched === null) || countsOf(waiting.counts).total > SYNC_ROW_LIMIT;
  // Checked before anything changes, so an import is not left half-started.
  if (background && !(await deps.queue.ready())) {
    throw new WorkbookV2Error("IMPORT_UNAVAILABLE", 503, `Imports of more than ${SYNC_ROW_LIMIT.toLocaleString("en-US")} rows run in the background, which is unavailable right now. Try again shortly.`);
  }

  await withoutFileDetails("Could not confirm an import", () => db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const [record] = await tx.select().from(workbookImports).where(eq(workbookImports.id, importId)).limit(1).for("no key update");
    if (!record || record.status !== "awaiting_confirmation") throw stateConflict(record?.status ?? "cancelled");
    await lockLiveWorkbook(tx, actor.workspaceId, workbookId);

    const limit = await getWorkspaceRowLimit(tx, actor.workspaceId);
    const [rows] = await tx.select({ n: count() }).from(workbookRows).where(eq(workbookRows.workbookId, workbookId));
    if ((rows?.n ?? 0) >= limit) {
      throw new WorkbookV2Error("ROW_LIMIT_EXCEEDED", 422, `This workbook already holds its limit of ${limit.toLocaleString("en-US")} rows.`, { limit, rows: rows?.n ?? 0 });
    }

    const preview = record.preview as unknown as StoredPreview;
    const headers = preview.headers.map((h) => h.name);
    const columns = await columnsOf(tx, workbookId);
    const { problems, keyHeader } = checkMapping(headers, columns, choice.columns, choice.dedupe, MAX_COLUMNS);
    if (crm && !problems.length) {
      // A CRM or Apollo field goes only into a column that can hold it.
      choice.columns.forEach((mapping, i) => {
        const dataType = mapping.columnId === undefined ? mapping.newColumn!.dataType : columns.find((c) => c.id === mapping.columnId!.toLowerCase())!.dataType;
        const header = preview.headers[mapping.header]!;
        if (!header.fits.includes(dataType)) {
          problems.push({ path: `columns.${i}`, code: "INCOMPATIBLE_FIELD", message: `“${header.name}” can't be imported into a ${dataType.replace("_", " ")} column. Choose a text column or one that matches the field.` });
        }
      });
    }
    if (problems.length) throw new WorkbookV2Error("INVALID_IMPORT_MAPPING", 422, problems[0]!.message, { errors: problems });

    const planned: PlannedColumn[] = [];
    // In file order, so new columns appear in the order the file has them.
    for (const mapping of [...choice.columns].sort((a, b) => a.header - b.header)) {
      if (mapping.columnId !== undefined) {
        const column = columns.find((c) => c.id === mapping.columnId!.toLowerCase())!;
        planned.push({ header: mapping.header, columnId: column.id, name: column.name, dataType: column.dataType });
      } else {
        const { name, dataType } = mapping.newColumn!;
        const created = await addColumn(tx, actor, workbookId, { name, type: "input", config: { dataType } });
        planned.push({ header: mapping.header, columnId: created.data.id, name, dataType });
      }
    }
    const plan: ImportPlan = {
      headers,
      delimiter: preview.delimiter,
      columns: planned,
      dedupe:
        choice.dedupe.key === "none"
          ? { key: "none" }
          : { key: choice.dedupe.key as MatchKey, header: keyHeader!, columnId: planned.find((c) => c.header === keyHeader)!.columnId },
      requestId: actor.requestId ?? null,
    };
    const linked = fromSheet ? await linkSheetSource(tx, actor, record, plan, choice.idColumn ?? null, background) : null;
    const confirmed: ImportPlan | CrmImportPlan | SheetImportPlan = linked ? { ...plan, sheet: linked.sheet } : crm ? { ...plan, crm: { ...crm, background } } : plan;
    await tx
      .update(workbookImports)
      .set({
        status: "queued",
        plan: confirmed as unknown as Record<string, unknown>,
        preview: null,
        createdBy: actor.userId,
        confirmedAt: sql`now()`,
        updatedAt: sql`now()`,
        ...(linked ? { sheetSourceId: linked.sheet.sourceId, counts: { ...countsOf(record.counts), alreadyImported: 0 } } : {}),
      })
      .where(eq(workbookImports.id, importId));
  }));

  await startImport(db, deps, { importId, workspaceId: actor.workspaceId }, background);
  return { background, data: await getImport(db, actor.workspaceId, workbookId, importId, actor.userId) };
}

/** Abandons an import that has not been confirmed, and removes its file. */
export async function cancelImport(db: Db, storage: ImportStorage, workspaceId: string, workbookId: string, importId: string): Promise<ImportDto> {
  await requireImport(db, workspaceId, workbookId, importId);
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const [record] = await tx.select().from(workbookImports).where(eq(workbookImports.id, importId)).limit(1).for("no key update");
    if (!record || record.status !== "awaiting_confirmation") throw stateConflict(record?.status ?? "cancelled");
    await tx
      .update(workbookImports)
      .set({ status: "cancelled", preview: null, finishedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(workbookImports.id, importId));
  });
  await housekeepImport(db, storage, importId);
  return getImport(db, workspaceId, workbookId, importId);
}

/** The report of rows a finished import did not add. */
export async function openImportReport(db: Db, storage: ImportStorage, workspaceId: string, workbookId: string, importId: string): Promise<Readable> {
  const record = await requireImport(db, workspaceId, workbookId, importId);
  const unavailable = (message: string) => new WorkbookV2Error("REPORT_NOT_AVAILABLE", 404, message);
  if (!record.finishedAt) throw unavailable("The report is available when the import finishes.");
  if (!record.errorReportFile) {
    const { duplicates, skipped, failed } = countsOf(record.counts);
    throw unavailable(duplicates + skipped + failed ? "The report is still being prepared. Try again shortly." : "Every row was imported, so there is nothing to report.");
  }
  const stored = record.errorReportFile;
  const stream = await withoutFileDetails("Could not open an import report", () => storage.open(stored));
  if (!stream) throw unavailable("This report has expired. Reports are kept for 30 days.");
  return stream;
}
