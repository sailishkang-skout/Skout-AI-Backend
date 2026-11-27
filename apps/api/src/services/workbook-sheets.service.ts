import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { WorkbookV2Error, findLiveWorkbook, getWorkspaceRowLimit, lockLiveWorkbook, type WorkbookActor } from "./workbook-v2.service.js";
import { MAX_COLUMNS } from "./workbook-v2-columns.service.js";
import { inputDataType } from "./workbook-cell-values.js";
import { CsvFileError, inspectCsv } from "./workbook-import-csv.js";
import { suggestMapping, type ExistingColumn } from "./workbook-import-plan.js";
import { importStorage, uploadKey, withTempFile, type ImportStorage } from "./workbook-import-storage.js";
import { ImportFailure, describeFailure } from "./workbook-import-core.js";
import { housekeepImport, type ImportQueue } from "./workbook-import-runner.js";
import { SYNC_ROW_LIMIT, assertRoomForAnotherImport, getImport, startImport, toImportDto, type ImportDto } from "./workbook-imports.service.js";
import { SheetContentError, snapshotTab, uniqueColumns } from "./workbook-sheet-snapshot.js";
import type { SheetImportPlan, SheetMapping } from "./workbook-sheet-runner.js";
import { requireConnection, sheetsError, type SheetPreview } from "./workbook-sheet-confirm.js";
import { GoogleSheetsError, getSpreadsheet, type SheetTab } from "./google-sheets.client.js";
import type { SheetsReader } from "./workbook-sheets-access.js";

/**
 * Google Sheets as a row source (WB2-025): choosing a spreadsheet and tab, the preview, pulling new rows later, and
 * forgetting a tab. Confirming, progress, cancelling and the report are the import routes (WB2-020). Every read of
 * Google is made as the person asking, through their own connection.
 */
const { workbooks, workbookColumns, workbookRows, workbookImports, workbookSheetSources } = schema;
const log = createLogger("workbook-sheets");

/** A spreadsheet from its link, or its id alone. Only Google Sheets links are accepted. */
export function parseSpreadsheetLink(input: string): { spreadsheetId: string; sheetId: number | null } | null {
  const text = input.trim();
  if (/^[A-Za-z0-9_-]{25,200}$/.test(text)) return { spreadsheetId: text, sheetId: null };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || url.port || url.username) return null;
  // `/d/e/…` is a published copy, whose id the API doesn't know.
  const id = /^\/spreadsheets(?:\/u\/\d+)?\/d\/([A-Za-z0-9_-]{25,200})(?:\/|$)/.exec(url.pathname)?.[1];
  if (!id) return null;
  const gid = /(?:^|[#&?])gid=(\d{1,10})(?:&|$)/.exec(url.hash)?.[1] ?? url.searchParams.get("gid");
  return { spreadsheetId: id, sheetId: gid !== null && /^\d{1,10}$/.test(gid) ? Number(gid) : null };
}

function requireLink(input: string) {
  const parsed = parseSpreadsheetLink(input);
  if (!parsed) throw new WorkbookV2Error("SHEETS_INVALID_LINK", 422, "Paste the link of a Google Sheet, such as https://docs.google.com/spreadsheets/d/…");
  return parsed;
}

const userOf = (actor: WorkbookActor) => {
  if (!actor.userId) throw new WorkbookV2Error("SHEETS_NOT_CONNECTED", 409, "Google Sheets is connected by a person; sign in to use it.");
  return actor.userId;
};

export interface SheetsSpreadsheetDto {
  spreadsheetId: string;
  name: string;
  /** The tab the link pointed at, when it did. */
  linkedSheetId: number | null;
  tabs: Array<{ sheetId: number; name: string; rows: number; columns: number; sourceId: string | null }>;
}

export async function inspectSpreadsheet(db: Db, sheets: SheetsReader, actor: WorkbookActor, workbookId: string, link: string): Promise<SheetsSpreadsheetDto> {
  await findLiveWorkbook(db, actor.workspaceId, workbookId);
  const { spreadsheetId, sheetId } = requireLink(link);
  const userId = userOf(actor);
  await requireConnection(db, sheets, actor.workspaceId, userId);
  const spreadsheet = await sheets
    .read(actor.workspaceId, userId, ({ accessToken }) => getSpreadsheet(accessToken, spreadsheetId))
    .catch((error) => {
      throw sheetsError(error);
    });
  const sources = await db
    .select({ id: workbookSheetSources.id, sheetId: workbookSheetSources.sheetId })
    .from(workbookSheetSources)
    .where(and(eq(workbookSheetSources.workbookId, workbookId), eq(workbookSheetSources.spreadsheetId, spreadsheetId)));
  const sourceOf = new Map(sources.map((s) => [s.sheetId, s.id]));
  return {
    spreadsheetId,
    name: spreadsheet.name,
    linkedSheetId: sheetId !== null && spreadsheet.tabs.some((t) => t.sheetId === sheetId) ? sheetId : null,
    tabs: spreadsheet.tabs.map((t) => ({ ...t, sourceId: sourceOf.get(t.sheetId) ?? null })),
  };
}

async function columnsOf(db: Db, workbookId: string): Promise<ExistingColumn[]> {
  const rows = await db
    .select({ id: workbookColumns.id, name: workbookColumns.name, type: workbookColumns.type, config: workbookColumns.config, position: workbookColumns.position })
    .from(workbookColumns)
    .where(eq(workbookColumns.workbookId, workbookId))
    .orderBy(workbookColumns.position, workbookColumns.id);
  return rows.map((c) => ({ id: c.id, name: c.name, type: c.type, dataType: inputDataType(c.config) }));
}

/** Copies a tab, checks it like an uploaded CSV file, and keeps it with a preview until it is confirmed. */
export async function createSheetImport(db: Db, storage: ImportStorage, sheets: SheetsReader, actor: WorkbookActor, workbookId: string, input: { spreadsheet: string; sheetId: number }): Promise<ImportDto> {
  await findLiveWorkbook(db, actor.workspaceId, workbookId);
  const { spreadsheetId } = requireLink(input.spreadsheet);
  const userId = userOf(actor);
  const revision = await requireConnection(db, sheets, actor.workspaceId, userId);
  await assertRoomForAnotherImport(db, actor.workspaceId);

  return withTempFile(async (file) => {
    let read: { spreadsheetName: string; tab: SheetTab; rows: number; bytes: number };
    try {
      read = await sheets.read(actor.workspaceId, userId, async ({ accessToken }) => {
        const spreadsheet = await getSpreadsheet(accessToken, spreadsheetId);
        const tab = spreadsheet.tabs.find((t) => t.sheetId === input.sheetId);
        if (!tab) throw new GoogleSheetsError("tab_not_found");
        return { spreadsheetName: spreadsheet.name, tab, ...(await snapshotTab(accessToken, spreadsheetId, tab, file)) };
      });
    } catch (error) {
      if (error instanceof SheetContentError) throw new WorkbookV2Error("SHEET_INVALID", 422, error.message, { reason: error.reason });
      throw sheetsError(error);
    }
    if (!read.rows) throw new WorkbookV2Error("NOTHING_TO_ADD", 422, "The tab has headings but no rows yet.");

    let inspection;
    try {
      inspection = await inspectCsv(file);
    } catch (error) {
      if (!(error instanceof CsvFileError)) throw error;
      throw new WorkbookV2Error("SHEET_INVALID", 422, "The tab couldn't be read. Check for very long rows.", { reason: error.reason });
    }
    // The headings are the ones written to the copy, in its order.
    const headers = inspection.headers;
    const columns = await columnsOf(db, workbookId);
    const unique = await uniqueColumns(file, headers.length);
    const [source] = await db
      .select()
      .from(workbookSheetSources)
      .where(and(eq(workbookSheetSources.workbookId, workbookId), eq(workbookSheetSources.spreadsheetId, spreadsheetId), eq(workbookSheetSources.sheetId, input.sheetId)))
      .limit(1);
    const remembered = source ? (source.mapping as unknown as SheetMapping) : null;
    let suggestions = suggestMapping(headers, columns, MAX_COLUMNS, 200);
    if (remembered) {
      // The tab goes where it went before, as far as those columns are still there.
      suggestions = headers.map((header) => {
        const before = remembered.columns.find((m) => m.header.toLowerCase() === header.name.toLowerCase());
        const column = before && columns.find((c) => c.id === before.columnId && c.type === "input");
        return { header: header.index, target: column ? { columnId: column.id } : null };
      });
    }
    const idColumn = remembered?.idHeader ? headers.findIndex((h) => h.name.toLowerCase() === remembered.idHeader!.toLowerCase()) : -1;
    const sheetPreview: SheetPreview = {
      spreadsheetName: read.spreadsheetName,
      tabName: read.tab.name,
      unique,
      source: source ? { id: source.id, idColumn: idColumn < 0 ? null : idColumn, idHeading: remembered!.idHeader, identityColumnIds: remembered!.identity } : null,
    };

    const id = randomUUID();
    const key = uploadKey(actor.workspaceId, id);
    await storage.put(key, file);
    const plan: Pick<SheetImportPlan, "sheet"> = {
      sheet: { spreadsheetId, sheetId: input.sheetId, spreadsheetName: read.spreadsheetName, tabName: read.tab.name, userId, revision, pull: false },
    };
    try {
      await db.insert(workbookImports).values({
        id,
        workbookId,
        sourceType: "google_sheets",
        status: "awaiting_confirmation",
        createdBy: userId,
        fileName: `${read.spreadsheetName} · ${read.tab.name}`.slice(0, 255),
        fileBytes: read.bytes,
        fileKey: key,
        preview: { delimiter: inspection.delimiter, headers, rows: inspection.preview, suggestions, sheet: sheetPreview },
        plan: plan as unknown as Record<string, unknown>,
        counts: { total: read.rows, processed: 0, imported: 0, duplicates: 0, skipped: 0, failed: 0 },
      });
    } catch (error) {
      await storage.remove(key).catch((e) => log.error("could not remove a sheet copy", undefined, { importId: id, failure: describeFailure(e) }));
      // A database error's own text quotes the values, which here include what the sheet holds.
      throw new ImportFailure("Could not keep a sheet preview", error);
    }
    return getImport(db, actor.workspaceId, workbookId, id, userId);
  });
}

export interface SheetSourceDto {
  id: string;
  spreadsheetId: string;
  sheetId: number;
  spreadsheetName: string;
  tabName: string;
  /** The heading of the column that identifies rows; null when they go by their contents. */
  idColumn: string | null;
  rows: number;
  lastPulledAt: string | null;
  createdAt: string;
  /** The pull or import reading the tab now. */
  runningImportId: string | null;
}

export async function listSheetSources(db: Db, workspaceId: string, workbookId: string): Promise<SheetSourceDto[]> {
  await findLiveWorkbook(db, workspaceId, workbookId);
  const sources = await db.select().from(workbookSheetSources).where(eq(workbookSheetSources.workbookId, workbookId)).orderBy(desc(workbookSheetSources.createdAt), desc(workbookSheetSources.id));
  const running = sources.length
    ? await db
        .select({ id: workbookImports.id, sourceId: workbookImports.sheetSourceId })
        .from(workbookImports)
        .where(and(inArray(workbookImports.sheetSourceId, sources.map((s) => s.id)), inArray(workbookImports.status, ["queued", "processing"])))
    : [];
  const runningOf = new Map(running.map((r) => [r.sourceId, r.id]));
  return sources.map((s) => ({
    id: s.id,
    spreadsheetId: s.spreadsheetId,
    sheetId: s.sheetId,
    spreadsheetName: s.spreadsheetName,
    tabName: s.tabName,
    idColumn: (s.mapping as unknown as SheetMapping).idHeader,
    rows: s.rowCount,
    lastPulledAt: s.lastPulledAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    runningImportId: runningOf.get(s.id) ?? null,
  }));
}

async function requireSource(db: Db, workbookId: string, sourceId: string) {
  const [source] = await db.select().from(workbookSheetSources).where(and(eq(workbookSheetSources.id, sourceId), eq(workbookSheetSources.workbookId, workbookId))).limit(1);
  if (!source) throw new WorkbookV2Error("NOT_FOUND", 404, "Sheet not found");
  return source;
}

async function runningImport(db: Db, sourceId: string) {
  const [found] = await db
    .select()
    .from(workbookImports)
    .where(and(eq(workbookImports.sheetSourceId, sourceId), inArray(workbookImports.status, ["queued", "processing"])))
    .limit(1);
  return found ?? null;
}

/**
 * "Pull new rows": reads the tab again as the person asking and adds the rows it has not added before. While one read
 * of the tab is under way, asking again answers with that one.
 */
export async function pullSheetSource(
  db: Db,
  deps: { storage: ImportStorage; queue: ImportQueue; sheets: SheetsReader },
  actor: WorkbookActor,
  workbookId: string,
  sourceId: string
): Promise<{ background: boolean; alreadyRunning: boolean; data: ImportDto }> {
  await findLiveWorkbook(db, actor.workspaceId, workbookId);
  const source = await requireSource(db, workbookId, sourceId);
  const underWay = async (record: typeof workbookImports.$inferSelect) => {
    const data = toImportDto(record, { viewerId: actor.userId });
    return { background: data.background, alreadyRunning: true, data };
  };
  const busy = await runningImport(db, source.id);
  if (busy) return underWay(busy);

  const userId = userOf(actor);
  const revision = await requireConnection(db, deps.sheets, actor.workspaceId, userId);
  const mapping = source.mapping as unknown as SheetMapping;
  const byId = new Map((await columnsOf(db, workbookId)).map((c) => [c.id, c]));
  if (mapping.columns.some((m) => byId.get(m.columnId)?.type !== "input" || byId.get(m.columnId)?.dataType !== m.dataType)) {
    throw new WorkbookV2Error("SHEET_MAPPING_CHANGED", 409, "A column this tab fills was deleted or its type changed. Stop pulling from this tab and import it again.");
  }
  // Checked now so that a deleted sheet or lost access is answered at once.
  const tab = await deps.sheets
    .read(actor.workspaceId, userId, async ({ accessToken }) => {
      const spreadsheet = await getSpreadsheet(accessToken, source.spreadsheetId);
      const found = spreadsheet.tabs.find((t) => t.sheetId === source.sheetId);
      if (!found) throw new GoogleSheetsError("tab_not_found");
      return { spreadsheetName: spreadsheet.name, tabName: found.name };
    })
    .catch((error) => {
      throw sheetsError(error);
    });
  await assertRoomForAnotherImport(db, actor.workspaceId);
  const background = source.rowCount > SYNC_ROW_LIMIT;
  if (background && !(await deps.queue.ready())) {
    throw new WorkbookV2Error("IMPORT_UNAVAILABLE", 503, `Tabs of more than ${SYNC_ROW_LIMIT.toLocaleString("en-US")} rows are pulled in the background, which is unavailable right now. Try again shortly.`);
  }

  const id = randomUUID();
  const started = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await lockLiveWorkbook(tx, actor.workspaceId, workbookId);
    const racing = await runningImport(tx, source.id);
    if (racing) return racing;
    const limit = await getWorkspaceRowLimit(tx, actor.workspaceId);
    const [rows] = await tx.select({ n: count() }).from(workbookRows).where(eq(workbookRows.workbookId, workbookId));
    if ((rows?.n ?? 0) >= limit) {
      throw new WorkbookV2Error("ROW_LIMIT_EXCEEDED", 422, `This workbook already holds its limit of ${limit.toLocaleString("en-US")} rows.`, { limit, rows: rows?.n ?? 0 });
    }
    // The tab may have been forgotten meanwhile.
    await requireSource(tx, workbookId, source.id);
    const plan = {
      requestId: actor.requestId ?? null,
      sheet: { spreadsheetId: source.spreadsheetId, sheetId: source.sheetId, ...tab, userId, revision, sourceId: source.id, pull: true, background },
    };
    await tx.insert(workbookImports).values({
      id,
      workbookId,
      sourceType: "google_sheets",
      status: "queued",
      createdBy: userId,
      fileName: `${tab.spreadsheetName} · ${tab.tabName}`.slice(0, 255),
      plan,
      sheetSourceId: source.id,
      counts: { total: 0, processed: 0, imported: 0, duplicates: 0, skipped: 0, failed: 0, alreadyImported: 0 },
      confirmedAt: sql`now()`,
    });
    return null;
  });
  if (started) return underWay(started);
  await startImport(db, deps, { importId: id, workspaceId: actor.workspaceId }, background);
  const data = await getImport(db, actor.workspaceId, workbookId, id, userId);
  return { background: data.status === "queued" || data.status === "processing", alreadyRunning: false, data };
}

/** Stops pulling from a tab. Its rows stay; what was remembered about them is removed. */
export async function forgetSheetSource(db: Db, actor: WorkbookActor, workbookId: string, sourceId: string): Promise<void> {
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await lockLiveWorkbook(tx, actor.workspaceId, workbookId);
    await requireSource(tx, workbookId, sourceId);
    if (await runningImport(tx, sourceId)) throw new WorkbookV2Error("SHEET_IMPORT_RUNNING", 409, "This tab is being imported. Wait for that to finish.");
    await tx.delete(workbookSheetSources).where(eq(workbookSheetSources.id, sourceId));
  });
}

/** Cancels a person's unconfirmed sheet previews and removes the copies, as disconnecting does. */
export async function cancelSheetPreviews(db: Db, config: Env, workspaceId: string, userId: string): Promise<number> {
  const mine = await db
    .select({ id: workbookImports.id })
    .from(workbookImports)
    .innerJoin(workbooks, eq(workbooks.id, workbookImports.workbookId))
    .where(and(eq(workbooks.workspaceId, workspaceId), eq(workbookImports.createdBy, userId), eq(workbookImports.sourceType, "google_sheets"), eq(workbookImports.status, "awaiting_confirmation")));
  if (!mine.length) return 0;
  const cancelled = await db
    .update(workbookImports)
    .set({
      status: "cancelled",
      preview: null,
      error: { code: "SHEETS_DISCONNECTED", message: "Google Sheets was disconnected before this preview was confirmed." },
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(inArray(workbookImports.id, mine.map((m) => m.id)), eq(workbookImports.status, "awaiting_confirmation")))
    .returning({ id: workbookImports.id });
  const storage = importStorage(config);
  if (storage) for (const { id } of cancelled) await housekeepImport(db, storage, id);
  return cancelled.length;
}
