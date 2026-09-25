/**
 * AUTH-BE-16 (Microsoft, ADR-0007 D7) — Microsoft sign-in backend service (OAuth 2.0 code flow
 * + PKCE against the Microsoft identity platform v2.0 endpoints).
 *
 * Mirrors google-auth.service.ts (and reuses its PKCE, nonce, and safe-redirect helpers), with
 * the differences Microsoft needs:
 * - Dedicated login credentials only (MICROSOFT_OAUTH_*). The inbox/warm-up MICROSOFT_CLIENT_*
 *   app is never used for login — different scopes, different consent.
 * - Issuer: multi-tenant tokens are issued by https://login.microsoftonline.com/{tid}/v2.0, so the
 *   issuer is checked against the token's own `tid` (and against MICROSOFT_OAUTH_TENANT when that
 *   names a specific tenant).
 * - Email verification: Microsoft ID tokens carry no `email_verified`. The `email` claim is only
 *   trusted when the optional `xms_edov` ("email domain owner verified") claim is true; the app
 *   registration must emit `email` and `xms_edov` as optional ID-token claims. Without it the
 *   callback refuses with AUTH_EMAIL_NOT_VERIFIED (Ground Rule 5 — never link on an unverified
 *   email; this is the "nOAuth" account-takeover class).
 * - Identity: `tid:oid` (immutable per user per tenant), never the mutable email or
 *   preferred_username.
 */
import { randomBytes } from "node:crypto";
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";
import { HttpError } from "@skout/auth";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { signOAuthState, verifyOAuthState } from "../utils/oauth-state.js";
import { getRedis } from "../lib/redis.js";
import { validateSafeNextUrl } from "./google-auth.service.js";

const log = createLogger("microsoft-auth.service");

export const MICROSOFT_LOGIN_HOST = "https://login.microsoftonline.com";
export const MICROSOFT_STATE_TTL_SECONDS = 10 * 60; // 10 minutes
export const MICROSOFT_STATE_COOKIE_NAME = "skout_oauth_microsoft_state";
const STATE_PROVIDER_TAG = "microsoft";
const TENANT_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tenant(config: Env): string {
  return config.MICROSOFT_OAUTH_TENANT || "common";
}

export function microsoftAuthorizeEndpoint(config: Env): string {
  return `${MICROSOFT_LOGIN_HOST}/${tenant(config)}/oauth2/v2.0/authorize`;
}

export function microsoftTokenEndpoint(config: Env): string {
  return `${MICROSOFT_LOGIN_HOST}/${tenant(config)}/oauth2/v2.0/token`;
}

let _microsoftRemoteJwks: JWTVerifyGetKey | null = null;

export function getMicrosoftRemoteJwks(config: Env): JWTVerifyGetKey {
  if (!_microsoftRemoteJwks) {
    _microsoftRemoteJwks = createRemoteJWKSet(
      new URL(`${MICROSOFT_LOGIN_HOST}/${tenant(config)}/discovery/v2.0/keys`)
    );
  }
  return _microsoftRemoteJwks;
}

export function setMicrosoftRemoteJwks(jwkSet: JWTVerifyGetKey | null): void {
  _microsoftRemoteJwks = jwkSet;
}

export function resetMicrosoftRemoteJwks(): void {
  _microsoftRemoteJwks = null;
}

function getOAuthSigningSecret(config: Env): string {
  const secret = config.AUTH_REFRESH_TOKEN_PEPPER || config.INTEGRATION_ENCRYPTION_KEY;
  if (!secret) {
    throw new HttpError("Microsoft sign-in is not configured", 503);
  }
  return secret;
}

export function getMicrosoftOAuthCredentials(config: Env): { clientId: string; clientSecret: string } {
  const clientId = config.MICROSOFT_OAUTH_CLIENT_ID;
  const clientSecret = config.MICROSOFT_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new HttpError("Microsoft OAuth client is not configured", 503);
  }
  return { clientId, clientSecret };
}

export function getMicrosoftOAuthRedirectUri(config: Env): string {
  if (config.MICROSOFT_OAUTH_REDIRECT_URI) {
    return config.MICROSOFT_OAUTH_REDIRECT_URI;
  }
  const frontend = (config.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${frontend}/api/auth/microsoft/callback`;
}

// In-memory replay protection (single-use even when Redis is unavailable).
const consumedStateIds = new Map<string, number>();

function pruneExpiredConsumedStates(): void {
  const now = Date.now();
  const maxAgeMs = MICROSOFT_STATE_TTL_SECONDS * 1000;
  for (const [sid, timestamp] of consumedStateIds.entries()) {
    if (now - timestamp > maxAgeMs) consumedStateIds.delete(sid);
  }
}

export function clearConsumedMicrosoftStateIdsForTesting(): void {
  consumedStateIds.clear();
}

function redisKey(stateId: string): string {
  return `auth:oauth:microsoft:${stateId}`;
}

export async function createMicrosoftOAuthState(
  config: Env,
  opts: { verifier: string; nonce: string; next?: string }
): Promise<{ stateId: string; signedState: string }> {
  const stateId = randomBytes(16).toString("hex");
  const payload: Record<string, string> = {
    p: STATE_PROVIDER_TAG,
    sid: stateId,
    v: opts.verifier,
    n: opts.nonce,
    nxt: validateSafeNextUrl(opts.next),
    t: String(Date.now()),
  };
  const signedState = signOAuthState(payload, getOAuthSigningSecret(config));

  const redis = getRedis(config);
  if (redis) {
    try {
      await redis.set(redisKey(stateId), "1", "EX", MICROSOFT_STATE_TTL_SECONDS);
    } catch (err) {
      log.warn("createMicrosoftOAuthState: Redis store failed, relying on signed cookie", { err });
    }
  }
  return { stateId, signedState };
}

export async function verifyAndConsumeMicrosoftOAuthState(
  config: Env,
  signedState: string,
  cookieStateId?: string
): Promise<{ verifier: string; nonce: string; next: string } | null> {
  const parsed = verifyOAuthState(signedState, getOAuthSigningSecret(config));
  if (!parsed || parsed.p !== STATE_PROVIDER_TAG || !parsed.sid || !parsed.v || !parsed.n || !parsed.t) {
    return null; // Forged, malformed, or a state minted for another provider.
  }

  const createdAt = Number(parsed.t);
  if (Number.isNaN(createdAt) || Date.now() - createdAt > MICROSOFT_STATE_TTL_SECONDS * 1000) {
    return null;
  }

  const stateId = parsed.sid;
  pruneExpiredConsumedStates();
  if (consumedStateIds.has(stateId)) {
    log.warn("verifyAndConsumeMicrosoftOAuthState: state replay detected in memory");
    return null;
  }

  // Bound to the browser that started the flow.
  if (!cookieStateId || cookieStateId !== stateId) {
    return null;
  }

  const redis = getRedis(config);
  if (redis) {
    try {
      if ((await redis.del(redisKey(stateId))) === 0) {
        log.warn("verifyAndConsumeMicrosoftOAuthState: state replay detected in Redis");
        return null;
      }
    } catch (err) {
      log.warn("verifyAndConsumeMicrosoftOAuthState: Redis check failed", { err });
    }
  }

  consumedStateIds.set(stateId, Date.now());
  return { verifier: parsed.v, nonce: parsed.n, next: validateSafeNextUrl(parsed.nxt) };
}

export function buildMicrosoftAuthorizationUrl(
  config: Env,
  opts: { state: string; challenge: string; nonce: string }
): string {
  const { clientId } = getMicrosoftOAuthCredentials(config);
  const url = new URL(microsoftAuthorizeEndpoint(config));
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", getMicrosoftOAuthRedirectUri(config));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", opts.state);
  url.searchParams.set("nonce", opts.nonce);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export interface MicrosoftTokenResponse {
  id_token: string;
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

export async function exchangeMicrosoftCode(
  config: Env,
  code: string,
  codeVerifier: string
): Promise<MicrosoftTokenResponse> {
  const { clientId, clientSecret } = getMicrosoftOAuthCredentials(config);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: getMicrosoftOAuthRedirectUri(config),
    scope: "openid email profile",
  });

  const response = await fetch(microsoftTokenEndpoint(config), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    // Status only — the body can echo request parameters.
    log.error("exchangeMicrosoftCode: Microsoft token exchange failed", { status: response.status });
    throw new HttpError("Failed to exchange code with Microsoft", 401);
  }

  const data = (await response.json()) as MicrosoftTokenResponse;
  if (!data.id_token) {
    throw new HttpError("Microsoft response did not contain an id_token", 401);
  }
  return data;
}

export interface VerifiedMicrosoftUser {
  /** `${tid}:${oid}` — the stable provider subject stored in auth_identities. */
  subject: string;
  email: string;
  emailVerified: true;
  name?: string;
}

export async function verifyMicrosoftIdToken(
  config: Env,
  idToken: string,
  expectedNonce: string,
  options?: { keySet?: JWTVerifyGetKey }
): Promise<VerifiedMicrosoftUser> {
  const { clientId } = getMicrosoftOAuthCredentials(config);

  // The issuer embeds the tenant id, so read `tid` first (untrusted) to know which issuer to
  // demand; jwtVerify then checks the signature AND that iss matches exactly.
  let unverifiedTid: unknown;
  try {
    unverifiedTid = decodeJwt(idToken).tid;
  } catch {
    throw new HttpError("Invalid Microsoft ID token", 401);
  }
  if (typeof unverifiedTid !== "string" || !TENANT_GUID_RE.test(unverifiedTid)) {
    throw new HttpError("Invalid Microsoft ID token: missing tenant", 401);
  }
  const configuredTenant = tenant(config);
  if (TENANT_GUID_RE.test(configuredTenant) && configuredTenant.toLowerCase() !== unverifiedTid.toLowerCase()) {
    throw new HttpError("Invalid Microsoft ID token: tenant not allowed", 401);
  }

  let claims;
  try {
    const verified = await jwtVerify(idToken, options?.keySet || getMicrosoftRemoteJwks(config), {
      issuer: `${MICROSOFT_LOGIN_HOST}/${unverifiedTid}/v2.0`,
      audience: clientId,
      algorithms: ["RS256"],
    });
    claims = verified.payload;
  } catch (err) {
    // Never log `err` itself: jose's claim errors carry the whole token payload (email, name).
    const e = err as { code?: unknown; claim?: unknown };
    log.warn("verifyMicrosoftIdToken: signature/claims verification failed", {
      reason: typeof e.code === "string" ? e.code : "unknown",
      claim: typeof e.claim === "string" ? e.claim : undefined,
    });
    throw new HttpError("Invalid Microsoft ID token signature or claims", 401);
  }

  if (!claims.nonce || claims.nonce !== expectedNonce) {
    throw new HttpError("Invalid Microsoft ID token: nonce mismatch", 401);
  }

  const tid = typeof claims.tid === "string" ? claims.tid.toLowerCase() : "";
  const oid = typeof claims.oid === "string" ? claims.oid.trim().toLowerCase() : "";
  if (!tid || !oid) {
    throw new HttpError("Microsoft ID token missing tenant or object id", 401);
  }

  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const edov = claims.xms_edov;
  const isVerified = edov === true || edov === "true" || edov === 1 || edov === "1";
  if (!email || !isVerified) {
    log.warn("verifyMicrosoftIdToken: Microsoft account email is not verified");
    throw new HttpError("Microsoft email is not verified", 403);
  }

  return {
    subject: `${tid}:${oid}`,
    email,
    emailVerified: true,
    name: typeof claims.name === "string" ? claims.name.trim() : undefined,
  };
}
