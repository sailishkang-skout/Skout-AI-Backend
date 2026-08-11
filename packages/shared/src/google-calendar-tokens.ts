import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import type { Db } from "@skout/db";
import { decryptSecret, encryptSecret } from "./integration-crypto.js";

const { calendarConnections } = schema;

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Minimal config shape both apps/api and apps/crm's Env types already satisfy
 * structurally — kept independent of either app's own Env type so this stays
 * a pure, dependency-free shared module.
 */
export interface GoogleCalendarTokenConfig {
  readonly GOOGLE_CLIENT_ID?: string;
  readonly GOOGLE_CLIENT_SECRET?: string;
  readonly INTEGRATION_ENCRYPTION_KEY?: string;
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Refreshes a calendar_connections row's access token via Google's token
 * endpoint and persists the new value. Mirrors refreshGoogleToken() in
 * apps/api's inbox-oauth.service.ts, targeting calendar_connections instead
 * of inboxes.
 */
export async function refreshGoogleCalendarToken(
  connectionId: string,
  db: Db,
  config: GoogleCalendarTokenConfig
): Promise<string> {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)");
  }
  const key = config.INTEGRATION_ENCRYPTION_KEY;
  if (!key) throw new Error("INTEGRATION_ENCRYPTION_KEY not configured");

  const [row] = await db
    .select()
    .from(calendarConnections)
    .where(eq(calendarConnections.id, connectionId))
    .limit(1);
  if (!row?.oauthRefreshTokenEncrypted) throw new Error("No refresh token for calendar connection");

  const refreshToken = decryptSecret(row.oauthRefreshTokenEncrypted, key);

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google calendar token refresh failed: ${res.status}`);
  const tokens = (await res.json()) as GoogleTokenResponse;

  const accessEnc = encryptSecret(tokens.access_token, key);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  await db
    .update(calendarConnections)
    .set({ oauthAccessTokenEncrypted: accessEnc, oauthTokenExpiresAt: expiresAt, updatedAt: new Date() })
    .where(eq(calendarConnections.id, connectionId));

  return tokens.access_token;
}

/** Resolves a live access token for a calendar_connections row, refreshing first if it's expired or close to it. */
export async function resolveGoogleCalendarAccessToken(
  connection: typeof calendarConnections.$inferSelect,
  db: Db,
  config: GoogleCalendarTokenConfig
): Promise<string> {
  const key = config.INTEGRATION_ENCRYPTION_KEY;
  if (!key) throw new Error("INTEGRATION_ENCRYPTION_KEY not configured");

  const needsRefresh =
    !connection.oauthTokenExpiresAt ||
    connection.oauthTokenExpiresAt.getTime() < Date.now() + 5 * 60 * 1000;

  if (needsRefresh) return refreshGoogleCalendarToken(connection.id, db, config);

  return decryptSecret(connection.oauthAccessTokenEncrypted, key);
}
