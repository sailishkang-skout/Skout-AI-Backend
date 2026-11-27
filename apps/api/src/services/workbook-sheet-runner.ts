import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import type { InputDataType } from "./workbook-cell-values.js";
import type { DedupeKey, ImportPlan, MatchKey } from "./workbook-import-plan.js";
import { ImportStopped, RetryLater, Superseded, countsOf } from "./workbook-import-core.js";
import { uploadKey, withTempFile, type ImportStorage } from "./workbook-import-storage.js";
import { SheetContentError, snapshotTab } from "./workbook-sheet-snapshot.js";
import type { SheetIdentity } from "./workbook-sheet-identity.js";
import { GoogleSheetsError, getSpreadsheet } from "./google-sheets.client.js";
import { SHEETS_PROBLEMS, sheetsProblem, type SheetsReader } from "./workbook-sheets-access.js";

/**
 * What a Google Sheets import adds to the CSV import it runs on (WB2-025): reading the tab when new rows are pulled,
 * stopping when the connection it was started with goes away, and recognising rows added before.
 */
const { workbookColumns, workbookImports, workbookSheetSources, workbookSheetKeys } = schema;

/** What a source remembers so a later pull maps the tab the same way, by the headings it has then. */
export interface SheetMapping {
  columns: Array<{ header: string; columnId: string; dataType: InputDataType }>;
  dedupe: { key: DedupeKey; header: string | null };
  /** The heading of the ID column; null when rows are recognised by what they hold. */
  idHeader: string | null;
  /** Without an ID column: the workbook columns whose values identify a row, in order. */
  identity: string[];
}

/** Stored on a sheet import's plan, beside the CSV mapping. */
export interface SheetPlan {
  spreadsheetId: string;
  sheetId: number;
  spreadsheetName: string;
  tabName: string;
  /** Whose Google connection the import was started with, and which one. */
  userId: string;
  revision: string;
  sourceId?: string;
  identity?: SheetIdentity;
  idHeaderName?: string;
  /** Started by "Pull new rows": the tab is read by the import itself. */
  pull: boolean;
  background?: boolean;
}

export type SheetImportPlan = ImportPlan & { sheet: SheetPlan };

/** Pulls and imports above this many rows run in the background, as every import does. */
const BACKGROUND_OVER = 1_000;

export const SHEET_FAILED_MESSAGE =
  "The import stopped before it finished. Rows already imported are in the workbook. Use “Pull new rows” to add the rest; rows already added are skipped.";

const stopped = (message: string) => `${message} Rows already imported are in the workbook; pulling new rows skips them.`;

/** Turns a failure to read Google into the import's own terms. */
function fromGoogle(error: unknown): never {
  if (error instanceof SheetContentError) throw new ImportStopped(`SHEET_${error.reason}`, error.message);
  const problem = sheetsProblem(error);
  if (!problem) throw error;
  const [code, , message] = SHEETS_PROBLEMS[problem];
  if (error instanceof GoogleSheetsError && error.retryable) throw new RetryLater(code, stopped(message));
  throw new ImportStopped(code, stopped(message));
}

/** The connection the import was started with must still be there: disconnecting stops it. */
export async function assertSheetConnection(db: Db, sheets: SheetsReader, workspaceId: string, plan: SheetPlan): Promise<void> {
  const now = await sheets.revision(db, workspaceId, plan.userId);
  if (!now) throw new ImportStopped("SHEETS_DISCONNECTED", stopped("Google Sheets was disconnected, so the import stopped."));
  if (now.status !== "connected") throw new ImportStopped(SHEETS_PROBLEMS.reauth[0], stopped(SHEETS_PROBLEMS.reauth[2]));
  if (now.revision !== plan.revision) throw new ImportStopped("SHEETS_CONNECTION_CHANGED", stopped("Google Sheets was connected again during the import, so it stopped."));
}

const sameHeading = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Applies a source's remembered mapping to the headings the tab has now. */
export async function planFromSource(db: Db, workbookId: string, mapping: SheetMapping, headers: string[]): Promise<Pick<ImportPlan, "headers" | "delimiter" | "columns" | "dedupe"> & { identity: SheetIdentity }> {
  const found = await db.select({ id: workbookColumns.id, name: workbookColumns.name }).from(workbookColumns).where(eq(workbookColumns.workbookId, workbookId));
  const byId = new Map(found.map((c) => [c.id, c]));
  const at = (heading: string) => {
    const index = headers.findIndex((h) => sameHeading(h, heading));
    if (index < 0) throw new ImportStopped("SHEET_HEADING_MISSING", `The tab no longer has a column headed “${heading}”. Restore the heading, or stop pulling from this tab and import it again.`);
    return index;
  };
  const columns = mapping.columns.map((m) => {
    const column = byId.get(m.columnId);
    // A change of type is caught, as for every import, when the first rows are written.
    if (!column) {
      throw new ImportStopped("MAPPING_CHANGED", "A column this tab fills was deleted. Stop pulling from this tab and import it again.");
    }
    return { header: at(m.header), columnId: m.columnId, name: column.name, dataType: m.dataType };
  });
  let dedupe: ImportPlan["dedupe"] = { key: "none" };
  if (mapping.dedupe.key !== "none" && mapping.dedupe.header !== null) {
    const header = at(mapping.dedupe.header);
    dedupe = { key: mapping.dedupe.key as MatchKey, header, columnId: columns.find((c) => c.header === header)!.columnId };
  }
  const identity: SheetIdentity =
    mapping.idHeader !== null
      ? { kind: "id", header: at(mapping.idHeader) }
      : {
          kind: "content",
          headers: mapping.identity.map((columnId) => {
            const column = columns.find((c) => c.columnId === columnId);
            if (!column) throw new ImportStopped("MAPPING_CHANGED", "A column that identifies this tab's rows is no longer filled by it. Stop pulling from this tab and import it again.");
            return column.header;
          }),
        };
  return { headers, delimiter: ",", columns, dedupe, identity };
}

type Record_ = typeof workbookImports.$inferSelect;

/**
 * For a pull: reads the tab as it is now, keeps the copy, and fills in the import's plan. A first import already has its
 * copy from the preview. Answers null when the tab has no rows.
 */
export async function prepareSheetImport(db: Db, storage: ImportStorage, sheets: SheetsReader, workspaceId: string, record: Record_): Promise<Record_ | null> {
  const plan = record.plan as unknown as SheetImportPlan;
  await assertSheetConnection(db, sheets, workspaceId, plan.sheet);
  if (record.fileKey) return record;
  const [source] = await db.select().from(workbookSheetSources).where(eq(workbookSheetSources.id, record.sheetSourceId ?? "00000000-0000-0000-0000-000000000000")).limit(1);
  if (!source) throw new ImportStopped("SHEET_FORGOTTEN", "This tab is no longer pulled from.");
  return withTempFile(async (file) => {
    const read = await sheets
      .read(workspaceId, plan.sheet.userId, async ({ accessToken }) => {
        const spreadsheet = await getSpreadsheet(accessToken, plan.sheet.spreadsheetId);
        const tab = spreadsheet.tabs.find((t) => t.sheetId === plan.sheet.sheetId);
        if (!tab) throw new GoogleSheetsError("tab_not_found");
        return { spreadsheetName: spreadsheet.name, tabName: tab.name, ...(await snapshotTab(accessToken, plan.sheet.spreadsheetId, tab, file)) };
      })
      .catch(fromGoogle);
    const names = { spreadsheetName: read.spreadsheetName, tabName: read.tabName };
    await db.update(workbookSheetSources).set({ ...names, rowCount: read.rows, updatedAt: sql`now()` }).where(eq(workbookSheetSources.id, source.id));
    if (!read.rows) return null;
    const mapped = await planFromSource(db, record.workbookId, source.mapping as unknown as SheetMapping, read.headers);
    const idHeader = (source.mapping as unknown as SheetMapping).idHeader;
    const background = plan.sheet.background || read.rows > BACKGROUND_OVER;
    const next: SheetImportPlan = {
      headers: mapped.headers,
      delimiter: mapped.delimiter,
      columns: mapped.columns,
      dedupe: mapped.dedupe,
      requestId: plan.requestId,
      sheet: { ...plan.sheet, ...names, identity: mapped.identity, ...(idHeader === null ? {} : { idHeaderName: idHeader }), background },
    };
    const key = uploadKey(workspaceId, record.id);
    await storage.put(key, file);
    const [saved] = await db
      .update(workbookImports)
      .set({
        fileKey: key,
        fileBytes: read.bytes,
        fileName: `${read.spreadsheetName} · ${read.tabName}`.slice(0, 255),
        plan: next as unknown as Record<string, unknown>,
        counts: { ...countsOf(record.counts), total: read.rows },
        updatedAt: sql`now()`,
      })
      .where(and(eq(workbookImports.id, record.id), eq(workbookImports.status, "processing"), sql`${workbookImports.fileKey} IS NULL`))
      .returning();
    if (!saved) throw new Superseded();
    // Found to be large only now: the rest is done in the background.
    if (background && !plan.sheet.background) throw new RetryLater("SHEET_NEEDS_BACKGROUND", stopped("This tab is large enough to be imported in the background, which is unavailable right now."));
    return saved;
  });
}

/** Which of these identities the source has added before. */
export async function knownKeys(db: Db, sourceId: string, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const found = await db.select({ key: workbookSheetKeys.key }).from(workbookSheetKeys).where(and(eq(workbookSheetKeys.sourceId, sourceId), inArray(workbookSheetKeys.key, keys)));
  return new Set(found.map((r) => r.key));
}

export async function rememberKeys(db: Db, sourceId: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await db.execute(sql`
    INSERT INTO workbook_sheet_keys (source_id, key)
    SELECT ${sourceId}::uuid, x FROM jsonb_array_elements_text(${JSON.stringify(keys)}::text::jsonb) AS x`);
}

