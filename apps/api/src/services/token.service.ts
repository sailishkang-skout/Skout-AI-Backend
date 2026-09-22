/**
 * AUTH-BE-12 — own-auth access-token service: sign/verify short-lived JWTs, publish JWKS,
 * support key rotation.
 *
 * Scope note: this ticket also asks to "Add the Skout provider to resolveAuth (BE-03) as
 * SkoutAuthProvider" — that step needs AUTH-BE-03 (Sahil Sawal's AuthProvider/resolveAuth
 * abstraction in @skout/auth), which does not exist on this branch yet. This file is the
 * self-contained part (sign, verify, JWKS) that doesn't need it; wiring a SkoutAuthProvider
 * into resolveAuth is left as a follow-up once BE-03 lands — see the TODO at the bottom.
 *
 * Algorithm: RS256, not EdDSA. The ticket allows either; RS256 was chosen because AUTH-FE-07's
 * edge middleware needs to verify these tokens with WebCrypto in a Next.js edge runtime, where
 * RSA support is mature and universal — Ed25519 (EdDSA) support in edge/WebCrypto runtimes is
 * newer and less consistently available. jose's API is identical either way if this needs to
 * change later.
 */
import { SignJWT, createLocalJWKSet, jwtVerify, errors as joseErrors } from "jose";
import type { JWK, JSONWebKeySet } from "jose";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";

export const ACCESS_TOKEN_TTL_SECONDS = 10 * 60; // §3: access 10 min

export interface AccessTokenClaims {
  sub: string; // users.id UUID
  sid: string; // auth_sessions.id
}

export interface VerifiedAccessToken {
  sub: string;
  sid: string;
  iat: number;
  exp: number;
}

function requireKeyConfig(config: Env) {
  if (!config.AUTH_JWT_PRIVATE_KEY || !config.AUTH_JWT_KID || !config.AUTH_JWT_PUBLIC_KEY_SET) {
    throw new HttpError(
      "AUTH_JWT_PRIVATE_KEY, AUTH_JWT_KID, and AUTH_JWT_PUBLIC_KEY_SET must all be set to use own-auth tokens. " +
        "For local dev, run scripts/generate-local-auth-keys.mjs.",
      503
    );
  }
  return {
    privateKeyPem: config.AUTH_JWT_PRIVATE_KEY,
    kid: config.AUTH_JWT_KID,
    jwks: config.AUTH_JWT_PUBLIC_KEY_SET,
  };
}

type PrivateKey = Awaited<ReturnType<typeof import("jose").importPKCS8>>;

let cachedPrivateKey: { pem: string; key: PrivateKey } | null = null;

async function loadPrivateKey(pem: string): Promise<PrivateKey> {
  if (cachedPrivateKey && cachedPrivateKey.pem === pem) return cachedPrivateKey.key;
  const { importPKCS8 } = await import("jose");
  const key = await importPKCS8(pem, "RS256");
  cachedPrivateKey = { pem, key };
  return key;
}

/** Sign a short-lived access token. Deliberately minimal claims (§3) — no email/role/workspace;
 *  the backend re-resolves those from Postgres per request, same as it does for Clerk tokens
 *  today. */
export async function signAccessToken(claims: AccessTokenClaims, config: Env): Promise<string> {
  const { privateKeyPem, kid } = requireKeyConfig(config);
  const privateKey = await loadPrivateKey(privateKeyPem);
  return new SignJWT({ sid: claims.sid })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(config.AUTH_JWT_ISSUER)
    .setAudience(config.AUTH_JWT_AUDIENCE)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(privateKey);
}

const jwksCache = new Map<string, ReturnType<typeof createLocalJWKSet>>();

function getJwksVerifier(jwksJson: string) {
  let verifier = jwksCache.get(jwksJson);
  if (!verifier) {
    const jwks = JSON.parse(jwksJson) as JSONWebKeySet;
    verifier = createLocalJWKSet(jwks);
    // Bound the cache — in practice there are only ever 1-2 distinct key-set values live
    // (current + mid-rotation), this just guards against unbounded growth from bad input.
    if (jwksCache.size > 4) jwksCache.clear();
    jwksCache.set(jwksJson, verifier);
  }
  return verifier;
}

/**
 * Verify an access token. Enforces: RS256 only (never `none`, never an HMAC alg — a token can't
 * pick its own algorithm), issuer, audience, and a small clock-skew allowance. Key selection is
 * by `kid` against the published JWKS only — an unknown `kid` fails closed, it never falls back
 * to trusting an attacker-supplied key.
 */
export async function verifyAccessToken(token: string, config: Env): Promise<VerifiedAccessToken> {
  const { jwks } = requireKeyConfig(config);
  const verifier = getJwksVerifier(jwks);
  try {
    const { payload } = await jwtVerify(token, verifier, {
      issuer: config.AUTH_JWT_ISSUER,
      audience: config.AUTH_JWT_AUDIENCE,
      algorithms: ["RS256"],
      clockTolerance: 5, // seconds
    });
    if (!payload.sub || typeof payload.sid !== "string") {
      throw new HttpError("AUTH_TOKEN_INVALID", 401);
    }
    return {
      sub: payload.sub,
      sid: payload.sid,
      iat: payload.iat!,
      exp: payload.exp!,
    };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new HttpError("AUTH_TOKEN_EXPIRED", 401);
    }
    if (err instanceof HttpError) throw err;
    // Wrong alg, wrong kid, wrong iss/aud, tampered signature, not-yet-valid, malformed — jose
    // collapses these into its own error types; we deliberately don't leak which one to the
    // caller (generic AUTH_TOKEN_INVALID), matching Ground Rule 6.
    throw new HttpError("AUTH_TOKEN_INVALID", 401);
  }
}

/** The public JWKS to serve at GET /.well-known/jwks.json — already public-key-only material,
 *  served as-is (no private key ever touches this path). Deliberately only requires
 *  AUTH_JWT_PUBLIC_KEY_SET, not the signing key/kid — a verifier-only deployment (or a
 *  mid-rotation window where this instance isn't the one signing) can still publish keys. */
export function getPublicJwks(config: Env): JSONWebKeySet {
  if (!config.AUTH_JWT_PUBLIC_KEY_SET) {
    throw new HttpError(
      "AUTH_JWT_PUBLIC_KEY_SET must be set to serve the JWKS. For local dev, run scripts/generate-local-auth-keys.mjs.",
      503
    );
  }
  return JSON.parse(config.AUTH_JWT_PUBLIC_KEY_SET) as JSONWebKeySet;
}

export type { JWK, JSONWebKeySet };

// TODO(AUTH-BE-19): AUTH-BE-03 merged (resolveAuth/AuthProvider now exist in @skout/auth,
// PR #114) — checked the actual shape. Wiring a Skout provider in cleanly is bigger than "add
// one more branch to providerForIssuer", so it's left for BE-19 rather than forced in here:
//   1. resolve-auth.ts's `AuthVerifyContext` is Clerk-shaped (clerkSecretKey, authorizedParties)
//      — no room for JWT key material. It needs widening in @skout/auth first.
//   2. Per this ticket's own BE-19 context, a Skout token's downstream path is NOT
//      resolveOrProvisionUser (used for external IdPs) — sub is already users.id, so it's a
//      direct user lookup by id/status/is_blocked. Forcing that through the
//      AuthProvider/VerifiedIdentity shape built for Clerk would be a mismatch, not a reuse.
// verifyAccessToken() above is the piece BE-19 wraps once it designs that dispatch path.
