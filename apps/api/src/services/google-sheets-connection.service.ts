import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { schema, scopedTo, type Db } from "@skout/db";
import { createLogger } from "@skout/observability";
import { decryptSecretWithFallback, encryptSecret } from "@skout/shared";
import type { Env } from "../config/env.js";
import { getIntegrationEncryptionSecret } from "../utils/encryption-secrets.js";
import { HttpError } from "../utils/http.js";
import {
  GoogleSheetsError,
  SHEETS_SCOPE,
  exchangeSheetsCode,
  refreshSheetsToken,
  revokeSheetsToken,
  sheetsAuthorizeUrl,
  sheetsConfigured,
} from "./google-sheets.client.js";

/**
 * A member's connection to their own Google account for reading spreadsheets (WB2-025). Every function takes the
 * workspace and user from the session or from a server-side record, never from a request body, and returns no token to
 * anything outside the server.
 */
const { googleSheetsConnections: connections } = schema;
const log = createLogger("google-sheets");

export const SHEETS_STATE_TTL_MS = 10 * 60 * 1000;
/** An access token this close to expiring is renewed first. */
const RENEW_WITHIN_MS = 2 * 60 * 1000;

export interface SheetsConnectionDto {
  /** Whether this server has a Google app to connect with. */
  configured: boolean;
  status: "connected" | "needs_reauth" | "not_connected";
  connectedAt: string | null;
}

const hashOf = (state: string) => createHash("sha256").update(state).digest("hex");
const mine = (workspaceId: string, userId: string) => scopedTo(connections, workspaceId, eq(connections.userId, userId));

async function find(db: Db, workspaceId: string, userId: string) {
  const [row] = await db.select().from(connections).where(mine(workspaceId, userId)).limit(1);
  return row ?? null;
}

export async function sheetsConnection(db: Db, config: Env, workspaceId: string, userId: string): Promise<SheetsConnectionDto> {
  const row = await find(db, workspaceId, userId);
  const status = row?.status === "connected" || row?.status === "needs_reauth" ? row.status : "not_connected";
  return { configured: sheetsConfigured(config), status, connectedAt: status === "not_connected" ? null : (row!.connectedAt?.toISOString() ?? null) };
}

function requireConfigured(config: Env) {
  if (!sheetsConfigured(config)) throw new HttpError("google_sheets_not_configured", 503);
}

/** The Google sign-in address, with a state that works once, for ten minutes, for this member only. */
export async function startSheetsConnection(db: Db, config: Env, workspaceId: string, userId: string): Promise<{ authorizationUrl: string }> {
  requireConfigured(config);
  const state = randomBytes(32).toString("base64url");
  const pending = { stateHash: hashOf(state), stateExpiresAt: new Date(Date.now() + SHEETS_STATE_TTL_MS), updatedAt: new Date() };
  await db
    .insert(connections)
    .values({ workspaceId, userId, ...pending })
    // An existing connection keeps working while a new sign-in is under way.
    .onConflictDoUpdate({ target: [connections.workspaceId, connections.userId], set: pending });
  return { authorizationUrl: sheetsAuthorizeUrl(config, state) };
}

/**
 * Finishes a sign-in. Called by the app as the signed-in member with what Google sent back, so a sign-in started by one
 * person can't be completed into another's account, and a state works only once.
 */
export async function completeSheetsConnection(db: Db, config: Env, workspaceId: string, userId: string, input: { code: string; state: string }): Promise<SheetsConnectionDto> {
  requireConfigured(config);
  const [used] = await db
    .update(connections)
    .set({ stateHash: null, stateExpiresAt: null, updatedAt: new Date() })
    .where(and(mine(workspaceId, userId), eq(connections.stateHash, hashOf(input.state)), gt(connections.stateExpiresAt, new Date())))
    .returning({ id: connections.id });
  if (!used) throw new HttpError("invalid_oauth_state", 400);

  let tokens;
  try {
    tokens = await exchangeSheetsCode(config, input.code);
  } catch (error) {
    if (!(error instanceof GoogleSheetsError)) throw error;
    log.warn("Google Sheets sign-in could not be completed", { failure: error.failure });
    throw error.retryable ? new HttpError("google_unavailable", 502) : new HttpError("google_sign_in_failed", 400);
  }
  // Google lets a person untick a permission on the consent screen.
  if (!tokens.scopes.includes(SHEETS_SCOPE)) {
    await revokeSheetsToken(tokens.refreshToken ?? tokens.accessToken);
    throw new HttpError("google_permission_not_granted", 400);
  }
  if (!tokens.refreshToken) throw new HttpError("google_sign_in_failed", 400);

  const secret = getIntegrationEncryptionSecret(config);
  await db
    .update(connections)
    .set({
      status: "connected",
      accessTokenEncrypted: encryptSecret(tokens.accessToken, secret),
      refreshTokenEncrypted: encryptSecret(tokens.refreshToken, secret),
      tokenExpiresAt: tokens.expiresAt,
      connectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(mine(workspaceId, userId));
  log.info("Google Sheets connected", { workspaceId, userId });
  return sheetsConnection(db, config, workspaceId, userId);
}

function decrypt(config: Env, payload: string | null): string | null {
  if (!payload) return null;
  try {
    return decryptSecretWithFallback(payload, getIntegrationEncryptionSecret(config), config.INTEGRATION_ENCRYPTION_KEY_PREVIOUS);
  } catch {
    return null;
  }
}

/**
 * Forgets the tokens first, so nothing more can be read, then withdraws the grant at Google. Rows already imported are
 * untouched. `revokedAtGoogle` is false when Google didn't confirm, so the person can remove it there themselves.
 */
export async function disconnectSheets(db: Db, config: Env, workspaceId: string, userId: string): Promise<{ disconnected: boolean; revokedAtGoogle: boolean }> {
  const [removed] = await db.delete(connections).where(mine(workspaceId, userId)).returning();
  if (!removed || (removed.status !== "connected" && removed.status !== "needs_reauth")) return { disconnected: false, revokedAtGoogle: false };
  const token = decrypt(config, removed.refreshTokenEncrypted) ?? decrypt(config, removed.accessTokenEncrypted);
  const revokedAtGoogle = token ? await revokeSheetsToken(token) : false;
  log.info("Google Sheets disconnected", { workspaceId, userId, revokedAtGoogle });
  return { disconnected: true, revokedAtGoogle };
}

export interface SheetsAccess {
  accessToken: string;
  /** Which connection this is; it changes when the member connects again. */
  revision: string;
}

/** Which connection a member has now, without calling Google. Null when there is none that works. */
export async function sheetsRevision(db: Db, workspaceId: string, userId: string): Promise<{ status: string; revision: string } | null> {
  const row = await find(db, workspaceId, userId);
  if (!row || row.status === "pending") return null;
  return { status: row.status, revision: `${row.id}:${row.connectedAt?.getTime() ?? 0}` };
}

async function needsReauth(db: Db, id: string, refreshTokenEncrypted: string | null) {
  // Only if it is still the same grant: a newer one is left alone.
  await db
    .update(connections)
    .set({ status: "needs_reauth", accessTokenEncrypted: null, updatedAt: new Date() })
    .where(and(eq(connections.id, id), refreshTokenEncrypted ? eq(connections.refreshTokenEncrypted, refreshTokenEncrypted) : sql`${connections.refreshTokenEncrypted} IS NULL`));
}

/** A current access token for a member, renewed if need be. Throws `GoogleSheetsError`, or `NotConnected`. */
async function open(db: Db, config: Env, workspaceId: string, userId: string, renew: boolean): Promise<SheetsAccess> {
  const row = await find(db, workspaceId, userId);
  if (!row || row.status === "pending") throw new SheetsNotConnected();
  if (row.status !== "connected") throw new GoogleSheetsError("reauth");
  const revision = `${row.id}:${row.connectedAt?.getTime() ?? 0}`;
  const stored = decrypt(config, row.accessTokenEncrypted);
  if (!renew && stored && row.tokenExpiresAt && row.tokenExpiresAt.getTime() > Date.now() + RENEW_WITHIN_MS) return { accessToken: stored, revision };
  const refreshToken = decrypt(config, row.refreshTokenEncrypted);
  if (!refreshToken) {
    await needsReauth(db, row.id, row.refreshTokenEncrypted);
    throw new GoogleSheetsError("reauth");
  }
  let tokens;
  try {
    tokens = await refreshSheetsToken(config, refreshToken);
  } catch (error) {
    if (error instanceof GoogleSheetsError && error.failure === "reauth") await needsReauth(db, row.id, row.refreshTokenEncrypted);
    throw error;
  }
  const secret = getIntegrationEncryptionSecret(config);
  const [saved] = await db
    .update(connections)
    .set({ accessTokenEncrypted: encryptSecret(tokens.accessToken, secret), tokenExpiresAt: tokens.expiresAt, updatedAt: new Date() })
    .where(and(eq(connections.id, row.id), eq(connections.refreshTokenEncrypted, row.refreshTokenEncrypted!)))
    .returning({ id: connections.id });
  // Disconnected, or connected again, while Google was answering.
  if (!saved) throw new SheetsNotConnected();
  return { accessToken: tokens.accessToken, revision };
}

export class SheetsNotConnected extends Error {
  constructor() {
    super("Google Sheets is not connected");
    this.name = "SheetsNotConnected";
  }
}

/**
 * Reads from Google as a member. A refused access token is renewed once and tried again; if Google still refuses, the
 * connection is marked for reconnecting.
 */
export async function withSheets<T>(db: Db, config: Env, workspaceId: string, userId: string, work: (access: SheetsAccess) => Promise<T>): Promise<T> {
  requireConfigured(config);
  const access = await open(db, config, workspaceId, userId, false);
  try {
    return await work(access);
  } catch (error) {
    if (!(error instanceof GoogleSheetsError) || error.failure !== "reauth") throw error;
  }
  const renewed = await open(db, config, workspaceId, userId, true);
  try {
    return await work(renewed);
  } catch (error) {
    if (error instanceof GoogleSheetsError && error.failure === "reauth") {
      const row = await find(db, workspaceId, userId);
      if (row) await needsReauth(db, row.id, row.refreshTokenEncrypted);
    }
    throw error;
  }
}
