import { eq } from "drizzle-orm";
import { createDb, schema, scopedTo } from "@skout/db";
import {
  encryptSecret,
  findCalendarConnectionForUser,
  listGoogleCalendarEvents,
  resolveGoogleCalendarAccessToken,
  type CalendarEventSummary,
} from "@skout/shared";
import type { Env } from "../config/env.js";
import { signOAuthState, verifyOAuthState } from "../utils/oauth-state.js";
import { HttpError } from "../utils/http.js";

type Db = ReturnType<typeof createDb>["db"];
const { calendarConnections } = schema;

/*
==================================================
GOOGLE CALENDAR OAUTH
==================================================

Per-user Google Calendar connection (each rep connects
their own calendar — mirrors how meetings.organizerId
is already user-scoped). Modeled directly on
inbox-oauth.service.ts's Google flow: same token
exchange, same signOAuthState/verifyOAuthState CSRF
protection, same encrypt-at-rest pattern — but the
state payload also carries userId (inbox connection is
workspace-scoped only; a calendar connection is not
shared across a workspace's users), and tokens land in
calendar_connections instead of inboxes.
==================================================
*/

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// calendar.events — create/update events on the user's calendar. Deliberately narrower than
// full calendar management (no calendar-list/settings access needed for this feature).
const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "email",
  "profile",
].join(" ");

function callbackUrl(config: Env): string {
  const base = (config.API_PUBLIC_URL ?? "http://localhost:3001").replace(/\/$/, "");
  return `${base}/api/v1/calendar/connect/google/callback`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

interface GoogleUserInfo {
  email: string;
}

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new HttpError("Failed to fetch Google user info", 502);
  return res.json() as Promise<GoogleUserInfo>;
}

export function getGoogleCalendarConnectUrl(workspaceId: string, userId: string, config: Env): string {
  if (!config.GOOGLE_CLIENT_ID) throw new HttpError("Google OAuth not configured", 503);
  const state = signOAuthState({ workspaceId, userId }, config.INTEGRATION_ENCRYPTION_KEY ?? "");
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(config),
    response_type: "code",
    scope: GOOGLE_CALENDAR_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

export async function handleGoogleCalendarCallback(
  code: string,
  state: string,
  db: Db,
  config: Env
): Promise<{ workspaceId: string; redirectUrl: string }> {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    throw new HttpError("Google OAuth not configured", 503);
  }

  const payload = verifyOAuthState(state, config.INTEGRATION_ENCRYPTION_KEY ?? "");
  if (!payload?.workspaceId || !payload?.userId) throw new HttpError("invalid_oauth_state", 400);
  const { workspaceId, userId } = payload;

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(config),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new HttpError(`Google token exchange failed: ${err}`, 502);
  }
  const tokens = (await tokenRes.json()) as TokenResponse;

  const userInfo = await fetchGoogleUserInfo(tokens.access_token);
  if (!userInfo.email) throw new HttpError("Could not determine Google account email", 502);

  const key = config.INTEGRATION_ENCRYPTION_KEY;
  if (!key) throw new HttpError("INTEGRATION_ENCRYPTION_KEY not configured", 503);

  const accessEnc = encryptSecret(tokens.access_token, key);
  const refreshEnc = tokens.refresh_token ? encryptSecret(tokens.refresh_token, key) : null;
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  await db
    .insert(calendarConnections)
    .values({
      workspaceId,
      userId,
      connectedEmail: userInfo.email,
      oauthAccessTokenEncrypted: accessEnc,
      oauthRefreshTokenEncrypted: refreshEnc,
      oauthTokenExpiresAt: expiresAt,
      oauthScope: tokens.scope ?? null,
    })
    .onConflictDoUpdate({
      target: [calendarConnections.workspaceId, calendarConnections.userId],
      set: {
        connectedEmail: userInfo.email,
        oauthAccessTokenEncrypted: accessEnc,
        // A re-consent that doesn't return a refresh token (Google only issues one on first
        // consent, or when prompt=consent forces a fresh grant — which we always request, so
        // this should be rare) must not overwrite a previously-stored one with null.
        ...(refreshEnc ? { oauthRefreshTokenEncrypted: refreshEnc } : {}),
        oauthTokenExpiresAt: expiresAt,
        oauthScope: tokens.scope ?? null,
        updatedAt: new Date(),
      },
    });

  const frontend = (config.FRONTEND_URL ?? config.CORS_ORIGIN[0] ?? "http://localhost:3000").replace(/\/$/, "");
  return {
    workspaceId,
    // Next.js basePath is "/app" — omitting it 404'd this redirect.
    redirectUrl: `${frontend}/app/settings/calendar?connected=google`,
  };
}

export interface CalendarConnectionStatus {
  connected: boolean;
  connectedEmail: string | null;
}

export async function getCalendarConnectionStatus(
  db: Db,
  workspaceId: string,
  userId: string
): Promise<CalendarConnectionStatus> {
  const row = await findCalendarConnectionForUser(db, userId, workspaceId);
  return { connected: Boolean(row), connectedEmail: row?.connectedEmail ?? null };
}

export async function listConnectedGoogleCalendarEvents(
  db: Db,
  workspaceId: string,
  userId: string,
  config: Env,
  range: { timeMin: Date; timeMax: Date }
): Promise<{ data: CalendarEventSummary[]; connected: boolean }> {
  const connection = await findCalendarConnectionForUser(db, userId, workspaceId);
  if (!connection) return { data: [], connected: false };

  const accessToken = await resolveGoogleCalendarAccessToken(connection, db, config);
  const data = await listGoogleCalendarEvents(accessToken, range);
  return { data, connected: true };
}

export async function disconnectCalendar(db: Db, workspaceId: string, userId: string): Promise<boolean> {
  const deleted = await db
    .delete(calendarConnections)
    .where(scopedTo(calendarConnections, workspaceId, eq(calendarConnections.userId, userId)))
    .returning({ id: calendarConnections.id });
  return deleted.length > 0;
}
