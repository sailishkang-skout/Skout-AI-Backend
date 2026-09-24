/**
 * AUTH-BE-16 — Google sign-in backend service (OAuth 2.0 code flow + PKCE).
 *
 * Implements PKCE verifier/challenge generation, signed state handling with anti-replay,
 * token exchange with Google, ID token verification via Google JWKS (with nonce + email_verified checks),
 * and safe server-side redirect target allowlisting.
 */
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { HttpError } from "@skout/auth";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { signOAuthState, verifyOAuthState } from "../utils/oauth-state.js";
import { getRedis } from "../lib/redis.js";

const log = createLogger("google-auth.service");

export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export const GOOGLE_STATE_TTL_SECONDS = 10 * 60; // 10 minutes
export const GOOGLE_STATE_COOKIE_NAME = "skout_oauth_google_state";

let _googleRemoteJwks: JWTVerifyGetKey | null = null;

export function getGoogleRemoteJwks(): JWTVerifyGetKey {
  if (!_googleRemoteJwks) {
    _googleRemoteJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  }
  return _googleRemoteJwks;
}

export function setGoogleRemoteJwks(jwkSet: JWTVerifyGetKey | null): void {
  _googleRemoteJwks = jwkSet;
}

export function resetGoogleRemoteJwks(): void {
  _googleRemoteJwks = null;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

export function generateNonce(): string {
  return randomBytes(16).toString("base64url");
}

function getOAuthSigningSecret(config: Env): string {
  return config.AUTH_REFRESH_TOKEN_PEPPER || config.INTEGRATION_ENCRYPTION_KEY || "skout-google-oauth-state-secret";
}

export function getGoogleOAuthCredentials(config: Env): { clientId: string; clientSecret?: string } {
  const clientId = config.GOOGLE_OAUTH_CLIENT_ID || config.GOOGLE_CLIENT_ID;
  const clientSecret = config.GOOGLE_OAUTH_CLIENT_SECRET || config.GOOGLE_CLIENT_SECRET;
  if (!clientId) {
    throw new HttpError("Google OAuth client ID is not configured", 503);
  }
  return { clientId, clientSecret };
}

export function getGoogleOAuthRedirectUri(config: Env): string {
  if (config.GOOGLE_OAUTH_REDIRECT_URI) {
    return config.GOOGLE_OAUTH_REDIRECT_URI;
  }
  const frontend = (config.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${frontend}/api/auth/google/callback`;
}

/** Server-side redirect allowlist — prevents open redirect attacks. */
export function validateSafeNextUrl(next: string | undefined): string {
  if (!next || typeof next !== "string") return "/dashboard";
  const trimmed = next.trim();
  // Must be an internal relative path: starts with single '/', no protocol, no '//', no '\'
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\") || trimmed.includes(":")) {
    return "/dashboard";
  }
  // Allowlist known application paths
  const ALLOWED_PREFIXES = [
    "/dashboard",
    "/onboarding",
    "/settings",
    "/prospects",
    "/sequences",
    "/inbox",
    "/campaigns",
    "/analytics",
    "/admin",
  ];
  if (trimmed === "/" || ALLOWED_PREFIXES.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix}/`))) {
    return trimmed;
  }
  return "/dashboard";
}

export interface GoogleOAuthStateData {
  stateId: string;
  verifier: string;
  nonce: string;
  next: string;
  createdAt: number;
}

// In-memory replay protection cache (ensures single-use guarantee even when Redis is unavailable)
const consumedStateIds = new Map<string, number>();

function pruneExpiredConsumedStates(): void {
  const now = Date.now();
  const maxAgeMs = GOOGLE_STATE_TTL_SECONDS * 1000;
  for (const [sid, timestamp] of consumedStateIds.entries()) {
    if (now - timestamp > maxAgeMs) {
      consumedStateIds.delete(sid);
    }
  }
}

export function clearConsumedStateIdsForTesting(): void {
  consumedStateIds.clear();
}

export async function createGoogleOAuthState(
  config: Env,
  opts: { verifier: string; nonce: string; next?: string }
): Promise<{ stateId: string; signedState: string }> {
  const stateId = randomBytes(16).toString("hex");
  const next = validateSafeNextUrl(opts.next);
  const payload: Record<string, string> = {
    sid: stateId,
    v: opts.verifier,
    n: opts.nonce,
    nxt: next,
    t: String(Date.now()),
  };

  const secret = getOAuthSigningSecret(config);
  const signedState = signOAuthState(payload, secret);

  // Store in Redis if available with 10-minute TTL for replay protection
  const redis = getRedis(config);
  if (redis) {
    try {
      await redis.set(`auth:oauth:google:${stateId}`, "1", "EX", GOOGLE_STATE_TTL_SECONDS);
    } catch (err) {
      log.warn("createGoogleOAuthState: Redis store failed, relying on signed cookie", { err });
    }
  }

  return { stateId, signedState };
}

export async function verifyAndConsumeGoogleOAuthState(
  config: Env,
  signedState: string,
  cookieStateId?: string
): Promise<{ verifier: string; nonce: string; next: string } | null> {
  const secret = getOAuthSigningSecret(config);
  const parsed = verifyOAuthState(signedState, secret);
  if (!parsed || !parsed.sid || !parsed.v || !parsed.n || !parsed.t) {
    return null;
  }

  const createdAt = Number(parsed.t);
  if (Number.isNaN(createdAt) || Date.now() - createdAt > GOOGLE_STATE_TTL_SECONDS * 1000) {
    return null; // Expired state
  }

  const stateId = parsed.sid;

  // In-memory anti-replay check
  pruneExpiredConsumedStates();
  if (consumedStateIds.has(stateId)) {
    log.warn("verifyAndConsumeGoogleOAuthState: State replay detected in memory", { stateId });
    return null;
  }

  // Bound to browser session/cookie check
  if (cookieStateId && cookieStateId !== stateId) {
    return null; // State ID mismatch with browser session
  }

  // Single-use anti-replay check via Redis if available
  const redis = getRedis(config);
  if (redis) {
    try {
      const exists = await redis.del(`auth:oauth:google:${stateId}`);
      if (exists === 0) {
        // Already consumed or expired in Redis
        log.warn("verifyAndConsumeGoogleOAuthState: State replay detected in Redis", { stateId });
        return null;
      }
    } catch (err) {
      log.warn("verifyAndConsumeGoogleOAuthState: Redis check failed", { err });
    }
  }

  // Mark as consumed in memory
  consumedStateIds.set(stateId, Date.now());

  return {
    verifier: parsed.v,
    nonce: parsed.n,
    next: validateSafeNextUrl(parsed.nxt),
  };
}

export function buildGoogleAuthorizationUrl(
  config: Env,
  opts: {
    state: string;
    challenge: string;
    nonce: string;
    redirectUriOverride?: string;
  }
): string {
  const { clientId } = getGoogleOAuthCredentials(config);
  const redirectUri = opts.redirectUriOverride || getGoogleOAuthRedirectUri(config);

  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", opts.state);
  url.searchParams.set("nonce", opts.nonce);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");

  return url.toString();
}

export interface GoogleTokenResponse {
  id_token: string;
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

export async function exchangeGoogleCode(
  config: Env,
  code: string,
  codeVerifier: string,
  redirectUriOverride?: string
): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret } = getGoogleOAuthCredentials(config);
  const redirectUri = redirectUriOverride || getGoogleOAuthRedirectUri(config);

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret || "",
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    log.error("exchangeGoogleCode: Google token exchange failed", {
      status: response.status,
      errorText,
    });
    throw new HttpError("Failed to exchange code with Google", 401);
  }

  const data = (await response.json()) as GoogleTokenResponse;
  if (!data.id_token) {
    throw new HttpError("Google response did not contain an id_token", 401);
  }
  return data;
}

export interface VerifiedGoogleUser {
  sub: string;
  email: string;
  emailVerified: true;
  name?: string;
  picture?: string;
}

export async function verifyGoogleIdToken(
  config: Env,
  idToken: string,
  expectedNonce: string,
  options?: { keySet?: JWTVerifyGetKey; expectedAudience?: string }
): Promise<VerifiedGoogleUser> {
  const { clientId } = getGoogleOAuthCredentials(config);
  const keySet = options?.keySet || getGoogleRemoteJwks();
  const aud = options?.expectedAudience || clientId;

  let verified;
  try {
    verified = await jwtVerify(idToken, keySet, {
      issuer: [...GOOGLE_ISSUERS],
      audience: aud,
    });
  } catch (err) {
    log.warn("verifyGoogleIdToken: ID token signature/claims verification failed", { err });
    throw new HttpError("Invalid Google ID token signature or claims", 401);
  }

  const claims = verified.payload;

  // Nonce check
  if (!claims.nonce || claims.nonce !== expectedNonce) {
    log.warn("verifyGoogleIdToken: Nonce mismatch", { expected: expectedNonce, received: claims.nonce });
    throw new HttpError("Invalid Google ID token: nonce mismatch", 401);
  }

  // Strict email_verified check — Ground Rule 5: never auto-link an account unless provider reports verified
  const isVerified = claims.email_verified === true || claims.email_verified === "true";
  if (!isVerified) {
    log.warn("verifyGoogleIdToken: Google account email is not verified", { email: claims.email });
    throw new HttpError("Google email is not verified", 403);
  }

  const sub = typeof claims.sub === "string" ? claims.sub.trim() : "";
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";

  if (!sub || !email) {
    throw new HttpError("Google ID token missing subject or email", 401);
  }

  return {
    sub,
    email,
    emailVerified: true,
    name: typeof claims.name === "string" ? claims.name.trim() : undefined,
    picture: typeof claims.picture === "string" ? claims.picture.trim() : undefined,
  };
}
