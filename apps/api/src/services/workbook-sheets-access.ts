import type { Db } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { GoogleSheetsError, type SheetsFailure } from "./google-sheets.client.js";
import { SheetsNotConnected, sheetsRevision, withSheets, type SheetsAccess } from "./google-sheets-connection.service.js";

/** A member's Google Sheets, as a workbook import uses it (WB2-025). */
export interface SheetsReader {
  /** Reads as the member. Throws `GoogleSheetsError`, `SheetsNotConnected` or, with no Google app set up, `HttpError`. */
  read<T>(workspaceId: string, userId: string, work: (access: SheetsAccess) => Promise<T>): Promise<T>;
  /** The member's connection now, without calling Google. */
  revision(db: Db, workspaceId: string, userId: string): Promise<{ status: string; revision: string } | null>;
}

export const sheetsReader = (db: Db, config: Env): SheetsReader => ({
  read: (workspaceId, userId, work) => withSheets(db, config, workspaceId, userId, work),
  revision: sheetsRevision,
});

export type SheetsProblem = SheetsFailure | "not_connected" | "not_configured";

/** What went wrong reading Google, or null when the error is something else. */
export function sheetsProblem(error: unknown): SheetsProblem | null {
  if (error instanceof GoogleSheetsError) return error.failure;
  if (error instanceof SheetsNotConnected) return "not_connected";
  if (error instanceof HttpError && error.message === "google_sheets_not_configured") return "not_configured";
  return null;
}

/** The code, HTTP status and words for each problem. Never 401, which would read as the Skout session ending. */
export const SHEETS_PROBLEMS = {
  not_configured: ["SHEETS_NOT_CONFIGURED", 503, "Google Sheets import isn't set up on this server."],
  not_connected: ["SHEETS_NOT_CONNECTED", 409, "Google Sheets isn't connected. Connect it in Settings, then try again."],
  reauth: ["SHEETS_RECONNECT_REQUIRED", 409, "Google access expired or was revoked. Reconnect Google Sheets in Settings, then try again."],
  scope: ["SHEETS_SCOPE_MISSING", 409, "The Google connection can't read spreadsheets. Reconnect Google Sheets in Settings and allow it."],
  forbidden: ["SHEETS_NO_ACCESS", 422, "Your Google account can't open this spreadsheet. Ask its owner to share it with you."],
  not_found: ["SHEETS_SPREADSHEET_NOT_FOUND", 422, "This spreadsheet doesn't exist or was deleted."],
  tab_not_found: ["SHEETS_TAB_NOT_FOUND", 422, "This tab doesn't exist or was deleted."],
  rate_limited: ["SHEETS_RATE_LIMITED", 429, "Google is limiting requests right now. Try again in a minute."],
  unavailable: ["SHEETS_UNAVAILABLE", 502, "Google Sheets couldn't be reached. Try again shortly."],
  rejected: ["SHEETS_REJECTED", 422, "Google refused to read this spreadsheet. Check that it is a Google Sheet."],
} as const satisfies Record<SheetsProblem, readonly [string, number, string]>;
