import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { WorkbookV2Error, type WorkbookActor } from "./workbook-v2.service.js";
import type { ImportPlan } from "./workbook-import-plan.js";
import type { SheetIdentity } from "./workbook-sheet-identity.js";
import type { SheetImportPlan, SheetMapping, SheetPlan } from "./workbook-sheet-runner.js";
import { GoogleSheetsError, getSpreadsheet } from "./google-sheets.client.js";
import { SHEETS_PROBLEMS, sheetsProblem, type SheetsReader } from "./workbook-sheets-access.js";

/** Confirming a Google Sheets preview (WB2-025): the connection checked, and the tab remembered as a source. */
const { workbookImports, workbookSheetSources } = schema;

/** What the preview of a tab adds to a CSV preview. */
export interface SheetPreview {
  spreadsheetName: string;
  tabName: string;
  /** Per heading: whether it has a different value on every row. Null where not checked. */
  unique: Array<boolean | null>;
  /** Set when this tab was imported into the workbook before: how its rows are recognised is then fixed. */
  source: {
    id: string;
    /** The heading position of its ID column; null when rows go by their contents, or the heading is gone. */
    idColumn: number | null;
    idHeading: string | null;
    /** Without an ID column: the workbook columns that identify a row, which must still be filled. */
    identityColumnIds: string[];
  } | null;
}

export function sheetsError(error: unknown): unknown {
  const problem = sheetsProblem(error);
  if (!problem) return error;
  const [code, status, message] = SHEETS_PROBLEMS[problem];
  return new WorkbookV2Error(code, status, message);
}

/** The person's connection, if it works. */
export async function requireConnection(db: Db, sheets: SheetsReader, workspaceId: string, userId: string): Promise<string> {
  const found = await sheets.revision(db, workspaceId, userId);
  const problem = !found ? "not_connected" : found.status !== "connected" ? "reauth" : null;
  if (problem) {
    const [code, status, message] = SHEETS_PROBLEMS[problem];
    throw new WorkbookV2Error(code, status, message);
  }
  return found!.revision;
}

/**
 * Only the person who previewed a tab may add it, through the connection they previewed it with, and Google must still
 * let them open it.
 */
export async function checkSheetConfirm(db: Db, sheets: SheetsReader, actor: WorkbookActor, record: typeof workbookImports.$inferSelect): Promise<void> {
  const { sheet } = record.plan as unknown as SheetImportPlan;
  if (!actor.userId || record.createdBy !== actor.userId) {
    throw new WorkbookV2Error("SHEETS_NOT_YOURS", 403, "Only the person who previewed this sheet can import it. Preview it with your own Google connection.");
  }
  const revision = await requireConnection(db, sheets, actor.workspaceId, actor.userId);
  if (revision !== sheet.revision) {
    throw new WorkbookV2Error("SHEETS_CONNECTION_CHANGED", 409, "Google Sheets was connected again since this preview. Cancel it and start again.");
  }
  await sheets
    .read(actor.workspaceId, actor.userId, async ({ accessToken }) => {
      const spreadsheet = await getSpreadsheet(accessToken, sheet.spreadsheetId);
      if (!spreadsheet.tabs.some((t) => t.sheetId === sheet.sheetId)) throw new GoogleSheetsError("tab_not_found");
    })
    .catch((error) => {
      throw sheetsError(error);
    });
}

const sameHeading = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const identityChanged = (message: string) => new WorkbookV2Error("SHEET_IDENTITY_CHANGED", 409, `${message} To change it, stop pulling from this tab first; its rows may then be added again.`);

/**
 * Inside the confirm's transaction, under the workbook's lock: creates or updates the tab's source with this mapping and
 * answers the import's sheet plan. A tab imported before keeps the way its rows are recognised, so none is added twice.
 */
export async function linkSheetSource(
  tx: Db,
  actor: WorkbookActor,
  record: typeof workbookImports.$inferSelect,
  plan: ImportPlan,
  idColumn: number | null,
  background: boolean
): Promise<{ sheet: SheetPlan }> {
  const { sheet } = record.plan as unknown as SheetImportPlan;
  if (idColumn !== null && idColumn >= plan.headers.length) {
    throw new WorkbookV2Error("INVALID_IMPORT_MAPPING", 422, "The tab has no such column to identify rows by.", { errors: [{ path: "idColumn", code: "UNKNOWN_HEADER", message: "The tab has no such column to identify rows by." }] });
  }
  const idHeading = idColumn === null ? null : plan.headers[idColumn]!;
  const [existing] = await tx
    .select()
    .from(workbookSheetSources)
    .where(and(eq(workbookSheetSources.workbookId, record.workbookId), eq(workbookSheetSources.spreadsheetId, sheet.spreadsheetId), eq(workbookSheetSources.sheetId, sheet.sheetId)))
    .limit(1);
  let identityColumns = idHeading === null ? plan.columns.map((c) => c.columnId) : [];
  if (existing) {
    const [running] = await tx
      .select({ id: workbookImports.id })
      .from(workbookImports)
      .where(and(eq(workbookImports.sheetSourceId, existing.id), inArray(workbookImports.status, ["queued", "processing"])))
      .limit(1);
    if (running) throw new WorkbookV2Error("SHEET_IMPORT_RUNNING", 409, "This tab is already being imported. Wait for that to finish.", { importId: running.id });
    const before = existing.mapping as unknown as SheetMapping;
    if (before.idHeader !== null) {
      if (idHeading === null || !sameHeading(idHeading, before.idHeader)) throw identityChanged(`Rows of this tab are recognised by the column headed “${before.idHeader}”.`);
    } else {
      if (idHeading !== null) throw identityChanged("Rows of this tab are recognised by their contents.");
      if (before.identity.some((id) => !plan.columns.some((c) => c.columnId === id))) {
        throw identityChanged("Rows of this tab are recognised by the columns it filled first, so all of them must still be filled.");
      }
      identityColumns = before.identity;
    }
  }
  const mapping: SheetMapping = {
    columns: plan.columns.map((c) => ({ header: plan.headers[c.header]!, columnId: c.columnId, dataType: c.dataType })),
    dedupe: { key: plan.dedupe.key, header: plan.dedupe.key === "none" ? null : plan.headers[plan.dedupe.header]! },
    idHeader: idHeading,
    identity: identityColumns,
  };
  const values = { spreadsheetName: sheet.spreadsheetName, tabName: sheet.tabName, mapping: mapping as unknown as Record<string, unknown>, rowCount: Number(record.counts?.total ?? 0) };
  const [source] = await tx
    .insert(workbookSheetSources)
    .values({ ...values, workbookId: record.workbookId, spreadsheetId: sheet.spreadsheetId, sheetId: sheet.sheetId, createdBy: actor.userId })
    .onConflictDoUpdate({ target: [workbookSheetSources.workbookId, workbookSheetSources.spreadsheetId, workbookSheetSources.sheetId], set: { ...values, updatedAt: new Date() } })
    .returning({ id: workbookSheetSources.id });
  const identity: SheetIdentity =
    idColumn !== null ? { kind: "id", header: idColumn } : { kind: "content", headers: identityColumns.map((id) => plan.columns.find((c) => c.columnId === id)!.header) };
  return { sheet: { ...sheet, sourceId: source!.id, identity, ...(idHeading === null ? {} : { idHeaderName: idHeading }), background } };
}
