import type { Env } from "../config/env.js";
import { productAppUrl } from "../utils/app-url.js";

/**
 * The calls Skout makes to Google for Sheets import (WB2-025): signing in, keeping the access current, revoking it, and
 * reading one spreadsheet. Nothing here writes to a spreadsheet. Tokens travel only in headers and request bodies, and
 * no error carries anything Google answered.
 */
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://sheets.googleapis.com/v4/spreadsheets";
const TIMEOUT_MS = 30_000;

/** Reads are retried a few times, waiting longer each time, as Google's quota guidance asks. */
export const SHEETS_RETRY = { attempts: 4, baseMs: 1_000, maxMs: 8_000 };

/**
 * `reauth`: access expired or was revoked. `scope`: signed in without permission to read spreadsheets. `forbidden`:
 * this account can't open this spreadsheet. `not_found` / `tab_not_found`: it is gone. `rate_limited` and
 * `unavailable`: worth trying later. `rejected`: Google refused the request as made.
 */
export type SheetsFailure = "reauth" | "scope" | "forbidden" | "not_found" | "tab_not_found" | "rate_limited" | "unavailable" | "rejected";

export class GoogleSheetsError extends Error {
  constructor(readonly failure: SheetsFailure) {
    super(`Google Sheets request failed: ${failure}`);
    this.name = "GoogleSheetsError";
  }
  get retryable() {
    return this.failure === "rate_limited" || this.failure === "unavailable";
  }
}

/** Sheets uses its own Google app, in its own Cloud project, so revoking it leaves Calendar and mailboxes alone. */
export const sheetsConfigured = (config: Env) => Boolean(config.GOOGLE_SHEETS_CLIENT_ID && config.GOOGLE_SHEETS_CLIENT_SECRET);

/** Where Google sends the browser back: a page of the app, which finishes the connection as the signed-in person. */
export const sheetsRedirectUri = (config: Env) =>
  config.GOOGLE_SHEETS_REDIRECT_URI ?? `${productAppUrl(config.FRONTEND_URL ?? config.CORS_ORIGIN[0] ?? "http://localhost:3000")}/settings/google-sheets`;

export function sheetsAuthorizeUrl(config: Env, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: config.GOOGLE_SHEETS_CLIENT_ID!,
    redirect_uri: sheetsRedirectUri(config),
    response_type: "code",
    scope: SHEETS_SCOPE,
    access_type: "offline",
    // Asking each time is what makes Google hand out a refresh token again.
    prompt: "consent",
    state,
  }).toString();
  return url.toString();
}

export interface SheetsTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

async function tokenRequest(config: Env, form: Record<string, string>): Promise<SheetsTokens> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...form, client_id: config.GOOGLE_SHEETS_CLIENT_ID!, client_secret: config.GOOGLE_SHEETS_CLIENT_SECRET! }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GoogleSheetsError("unavailable");
  }
  const body = (await res.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown } | null;
  if (!res.ok) {
    // `invalid_grant`: the code or refresh token no longer works.
    if (body?.error === "invalid_grant") throw new GoogleSheetsError("reauth");
    throw new GoogleSheetsError(res.status === 429 ? "rate_limited" : res.status >= 500 ? "unavailable" : "rejected");
  }
  if (typeof body?.access_token !== "string") throw new GoogleSheetsError("unavailable");
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresAt: new Date(Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000),
    scopes: typeof body.scope === "string" ? body.scope.split(" ") : [],
  };
}

export const exchangeSheetsCode = (config: Env, code: string) => tokenRequest(config, { grant_type: "authorization_code", code, redirect_uri: sheetsRedirectUri(config) });
export const refreshSheetsToken = (config: Env, refreshToken: string) => tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken });

/** Withdraws the grant at Google. False when Google didn't confirm it. */
export async function revokeSheetsToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});

/** What a refusal means. Only Google's machine-readable status and reason are looked at. */
function refusal(status: number, body: Json): SheetsFailure {
  const error = object(body.error);
  const reasons = Array.isArray(error.details) ? error.details.map((d) => String(object(d).reason ?? "")) : [];
  if (status === 401) return "reauth";
  if (status === 429 || reasons.includes("RATE_LIMIT_EXCEEDED")) return "rate_limited";
  if (status === 403) {
    if (reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) return "scope";
    // The Sheets API switched off for the app is Skout's setup, not the person's access.
    if (reasons.includes("SERVICE_DISABLED")) return "unavailable";
    return "forbidden";
  }
  if (status === 404) return "not_found";
  // A range naming a tab that isn't there can't be parsed.
  if (status === 400 && /unable to parse range/i.test(String(error.message ?? ""))) return "tab_not_found";
  if (status >= 500 || status === 408) return "unavailable";
  return "rejected";
}

async function once(accessToken: string, url: string): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new GoogleSheetsError("unavailable");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new GoogleSheetsError(refusal(res.status, object(body)));
  if (body === null) throw new GoogleSheetsError("unavailable");
  return object(body);
}

async function read(accessToken: string, url: string): Promise<Json> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await once(accessToken, url);
    } catch (error) {
      if (!(error instanceof GoogleSheetsError) || !error.retryable || attempt >= SHEETS_RETRY.attempts) throw error;
      const wait = Math.min(SHEETS_RETRY.maxMs, SHEETS_RETRY.baseMs * 2 ** (attempt - 1)) + Math.random() * SHEETS_RETRY.baseMs;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export interface SheetTab {
  sheetId: number;
  name: string;
  /** The size of the tab's grid, empty cells included. */
  rows: number;
  columns: number;
}

/** A spreadsheet's name and its tabs of cells. Charts on tabs of their own are left out. */
export async function getSpreadsheet(accessToken: string, spreadsheetId: string): Promise<{ name: string; tabs: SheetTab[] }> {
  const fields = "properties.title,sheets.properties(sheetId,title,sheetType,gridProperties(rowCount,columnCount))";
  const body = await read(accessToken, `${API}/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`);
  if (!Array.isArray(body.sheets)) throw new GoogleSheetsError("unavailable");
  const tabs = body.sheets.flatMap((sheet) => {
    const properties = object(object(sheet).properties);
    const grid = object(properties.gridProperties);
    if (properties.sheetType !== undefined && properties.sheetType !== "GRID") return [];
    if (typeof properties.sheetId !== "number" || typeof properties.title !== "string") return [];
    return [{ sheetId: properties.sheetId, name: properties.title, rows: Number(grid.rowCount ?? 0), columns: Number(grid.columnCount ?? 0) }];
  });
  return { name: String(object(body.properties).title ?? "Untitled spreadsheet"), tabs };
}

/** A column's letters: 1 is A, 27 is AA. */
export function columnLetters(column: number): string {
  let letters = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

/**
 * The values of rows `from` to `to` of one tab, as the sheet shows them. Rows come back in order from `from`; empty ones
 * at the end of the range, and empty cells at the end of a row, are left out by Google.
 */
export async function getRows(accessToken: string, spreadsheetId: string, tab: string, from: number, to: number, columns: number): Promise<string[][]> {
  const range = `'${tab.replaceAll("'", "''")}'!A${from}:${columnLetters(columns)}${to}`;
  const body = await read(accessToken, `${API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
  if (body.values === undefined) return [];
  if (!Array.isArray(body.values)) throw new GoogleSheetsError("unavailable");
  return body.values.map((row) => (Array.isArray(row) ? row.map((v) => (v === null || v === undefined ? "" : String(v))) : []));
}
