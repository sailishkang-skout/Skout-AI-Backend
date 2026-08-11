import { and, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { encryptSecret, decryptSecret } from "@skout/shared";
import { signOAuthState, verifyOAuthState } from "../utils/oauth-state.js";
import { HttpError } from "../utils/http.js";

type Db = ReturnType<typeof createDb>["db"];
const { inboxes } = schema;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPES = [
  "https://mail.google.com/",
  "email",
  "profile",
].join(" ");

const MICROSOFT_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MICROSOFT_SCOPES = [
  "https://outlook.office.com/SMTP.Send",
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "offline_access",
  "email",
  "openid",
].join(" ");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callbackUrl(config: Env, provider: "google" | "microsoft"): string {
  const base = (config.API_PUBLIC_URL ?? "http://localhost:3001").replace(/\/$/, "");
  return `${base}/api/v1/inboxes/connect/${provider}/callback`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
  id_token?: string;
}

interface GoogleUserInfo {
  email: string;
  name?: string;
}

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new HttpError("Failed to fetch Google user info", 502);
  return res.json() as Promise<GoogleUserInfo>;
}

interface MicrosoftUserInfo {
  mail?: string;
  userPrincipalName?: string;
  displayName?: string;
}

async function fetchMicrosoftUserInfo(accessToken: string): Promise<MicrosoftUserInfo> {
  const res = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new HttpError("Failed to fetch Microsoft user info", 502);
  return res.json() as Promise<MicrosoftUserInfo>;
}

async function storeOAuthInbox(
  db: Db,
  config: Env,
  workspaceId: string,
  emailAddress: string,
  displayName: string | null,
  provider: "google" | "microsoft",
  tokens: TokenResponse,
) {
  const key = config.INTEGRATION_ENCRYPTION_KEY;
  if (!key) throw new HttpError("INTEGRATION_ENCRYPTION_KEY not configured", 503);

  const accessEnc = encryptSecret(tokens.access_token, key);
  const refreshEnc = tokens.refresh_token ? encryptSecret(tokens.refresh_token, key) : null;
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  const imapDefaults =
    provider === "google"
      ? { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecure: true, smtpUsername: emailAddress }
      : {
          imapHost: "outlook.office365.com",
          imapPort: 993,
          smtpHost: "smtp.office365.com",
          smtpPort: 587,
          smtpSecure: false,
          smtpUsername: emailAddress,
        };

  const [row] = await db
    .insert(inboxes)
    .values({
      workspaceId,
      emailAddress,
      displayName,
      provider,
      status: "pending_verification",
      oauthAccessTokenEncrypted: accessEnc,
      oauthRefreshTokenEncrypted: refreshEnc,
      oauthTokenExpiresAt: expiresAt,
      oauthScope: tokens.scope ?? null,
      ...imapDefaults,
    })
    .onConflictDoUpdate({
      target: [inboxes.workspaceId, inboxes.emailAddress],
      set: {
        provider,
        displayName,
        status: "pending_verification",
        oauthAccessTokenEncrypted: accessEnc,
        oauthRefreshTokenEncrypted: refreshEnc,
        oauthTokenExpiresAt: expiresAt,
        oauthScope: tokens.scope ?? null,
        ...imapDefaults,
        updatedAt: new Date(),
      },
    })
    .returning();

  return row;
}

// ---------------------------------------------------------------------------
// Exported service functions
// ---------------------------------------------------------------------------

export function getGoogleConnectUrl(workspaceId: string, config: Env): string {
  if (!config.GOOGLE_CLIENT_ID) throw new HttpError("Google OAuth not configured", 503);
  const state = signOAuthState({ workspaceId, provider: "google" }, config.INTEGRATION_ENCRYPTION_KEY ?? "");
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(config, "google"),
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

export async function handleGoogleCallback(
  code: string,
  state: string,
  db: Db,
  config: Env,
): Promise<{ workspaceId: string; redirectUrl: string }> {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    throw new HttpError("Google OAuth not configured", 503);
  }

  const payload = verifyOAuthState(state, config.INTEGRATION_ENCRYPTION_KEY ?? "");
  if (!payload?.workspaceId) throw new HttpError("invalid_oauth_state", 400);
  const { workspaceId } = payload;

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(config, "google"),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new HttpError(`Google token exchange failed: ${err}`, 502);
  }
  const tokens = (await tokenRes.json()) as TokenResponse;

  const userInfo = await fetchGoogleUserInfo(tokens.access_token);
  if (!userInfo.email) throw new HttpError("Could not determine Gmail address", 502);

  await storeOAuthInbox(db, config, workspaceId, userInfo.email, userInfo.name ?? null, "google", tokens);

  const frontend = (config.FRONTEND_URL ?? config.CORS_ORIGIN[0] ?? "http://localhost:3000").replace(/\/$/, "");
  return {
    workspaceId,
    redirectUrl: `${frontend}/deliverability?connected=google`,
  };
}

export function getMicrosoftConnectUrl(workspaceId: string, config: Env): string {
  if (!config.MICROSOFT_CLIENT_ID) throw new HttpError("Microsoft OAuth not configured", 503);
  const state = signOAuthState({ workspaceId, provider: "microsoft" }, config.INTEGRATION_ENCRYPTION_KEY ?? "");
  const params = new URLSearchParams({
    client_id: config.MICROSOFT_CLIENT_ID,
    redirect_uri: callbackUrl(config, "microsoft"),
    response_type: "code",
    scope: MICROSOFT_SCOPES,
    response_mode: "query",
    state,
  });
  return `${MICROSOFT_AUTH_URL}?${params}`;
}

export async function handleMicrosoftCallback(
  code: string,
  state: string,
  db: Db,
  config: Env,
): Promise<{ workspaceId: string; redirectUrl: string }> {
  if (!config.MICROSOFT_CLIENT_ID || !config.MICROSOFT_CLIENT_SECRET) {
    throw new HttpError("Microsoft OAuth not configured", 503);
  }

  const payload = verifyOAuthState(state, config.INTEGRATION_ENCRYPTION_KEY ?? "");
  if (!payload?.workspaceId) throw new HttpError("invalid_oauth_state", 400);
  const { workspaceId } = payload;

  const tokenRes = await fetch(MICROSOFT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.MICROSOFT_CLIENT_ID,
      client_secret: config.MICROSOFT_CLIENT_SECRET,
      redirect_uri: callbackUrl(config, "microsoft"),
      grant_type: "authorization_code",
      scope: MICROSOFT_SCOPES,
    }),
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new HttpError(`Microsoft token exchange failed: ${err}`, 502);
  }
  const tokens = (await tokenRes.json()) as TokenResponse;

  const userInfo = await fetchMicrosoftUserInfo(tokens.access_token);
  const email = userInfo.mail ?? userInfo.userPrincipalName;
  if (!email) throw new HttpError("Could not determine Outlook address", 502);

  await storeOAuthInbox(db, config, workspaceId, email, userInfo.displayName ?? null, "microsoft", tokens);

  const frontend = (config.FRONTEND_URL ?? config.CORS_ORIGIN[0] ?? "http://localhost:3000").replace(/\/$/, "");
  return {
    workspaceId,
    redirectUrl: `${frontend}/deliverability?connected=microsoft`,
  };
}

// ---------------------------------------------------------------------------
// Token refresh (call before sending if token is close to expiry)
// ---------------------------------------------------------------------------

export async function refreshGoogleToken(
  inboxId: string,
  db: Db,
  config: Env,
): Promise<string> {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    throw new HttpError("Google OAuth not configured", 503);
  }
  const key = config.INTEGRATION_ENCRYPTION_KEY;
  if (!key) throw new HttpError("INTEGRATION_ENCRYPTION_KEY not configured", 503);

  const [row] = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
  if (!row?.oauthRefreshTokenEncrypted) throw new HttpError("No refresh token for inbox", 400);

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
  if (!res.ok) throw new HttpError("Google token refresh failed", 502);
  const tokens = (await res.json()) as TokenResponse;

  const accessEnc = encryptSecret(tokens.access_token, key);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  await db
    .update(inboxes)
    .set({ oauthAccessTokenEncrypted: accessEnc, oauthTokenExpiresAt: expiresAt, updatedAt: new Date() })
    .where(eq(inboxes.id, inboxId));

  return tokens.access_token;
}

export async function refreshMicrosoftToken(
  inboxId: string,
  db: Db,
  config: Env,
): Promise<string> {
  if (!config.MICROSOFT_CLIENT_ID || !config.MICROSOFT_CLIENT_SECRET) {
    throw new HttpError("Microsoft OAuth not configured", 503);
  }
  const key = config.INTEGRATION_ENCRYPTION_KEY;
  if (!key) throw new HttpError("INTEGRATION_ENCRYPTION_KEY not configured", 503);

  const [row] = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
  if (!row?.oauthRefreshTokenEncrypted) throw new HttpError("No refresh token for inbox", 400);

  const refreshToken = decryptSecret(row.oauthRefreshTokenEncrypted, key);

  const res = await fetch(MICROSOFT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.MICROSOFT_CLIENT_ID,
      client_secret: config.MICROSOFT_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: MICROSOFT_SCOPES,
    }),
  });
  if (!res.ok) throw new HttpError("Microsoft token refresh failed", 502);
  const tokens = (await res.json()) as TokenResponse;

  const accessEnc = encryptSecret(tokens.access_token, key);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  await db
    .update(inboxes)
    .set({ oauthAccessTokenEncrypted: accessEnc, oauthTokenExpiresAt: expiresAt, updatedAt: new Date() })
    .where(eq(inboxes.id, inboxId));

  return tokens.access_token;
}

// ---------------------------------------------------------------------------
// Resolve a live access token for an inbox (refresh if needed)
// ---------------------------------------------------------------------------

export async function resolveAccessToken(
  inbox: typeof inboxes.$inferSelect,
  db: Db,
  config: Env,
): Promise<string> {
  const key = config.INTEGRATION_ENCRYPTION_KEY;
  if (!key) throw new HttpError("INTEGRATION_ENCRYPTION_KEY not configured", 503);
  if (!inbox.oauthAccessTokenEncrypted) throw new HttpError("No OAuth token for inbox", 400);

  // Refresh if expired or within 5 minutes of expiry
  const needsRefresh =
    !inbox.oauthTokenExpiresAt ||
    inbox.oauthTokenExpiresAt.getTime() < Date.now() + 5 * 60 * 1000;

  if (needsRefresh) {
    if (inbox.provider === "google") return refreshGoogleToken(inbox.id, db, config);
    if (inbox.provider === "microsoft") return refreshMicrosoftToken(inbox.id, db, config);
    throw new HttpError("Cannot refresh token for provider: " + inbox.provider, 400);
  }

  return decryptSecret(inbox.oauthAccessTokenEncrypted, key);
}
