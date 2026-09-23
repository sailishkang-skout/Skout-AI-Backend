/**
 * AUTH-BE-15 — email verification, password reset, and email-OTP tokens.
 *
 * Raw codes and links are never stored. `auth_verification_tokens.token_hash` is an HMAC
 * of the value that was emailed. A token is single-use (`used_at`) and short-lived.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "@skout/auth";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { generateOtp } from "../utils/otp.js";
import { getRedis } from "../lib/redis.js";

const log = createLogger("auth-recovery.service");
const { authVerificationTokens, authIdentities } = schema;

export const VERIFICATION_TTL_MS = 15 * 60 * 1000;
export const VERIFICATION_TTL_MINUTES = 15;

export const ADDRESS_LIMIT = 5;
export const IP_LIMIT = 20;
const WINDOW_SECONDS = 15 * 60;

export type VerificationPurpose = "email_verify" | "password_reset" | "email_otp";

function requirePepper(config: Env): string {
  if (!config.AUTH_REFRESH_TOKEN_PEPPER) {
    throw new HttpError("AUTH_REFRESH_TOKEN_PEPPER is required for verification tokens", 503);
  }
  return config.AUTH_REFRESH_TOKEN_PEPPER;
}

export function hashVerificationToken(
  config: Env,
  purpose: VerificationPurpose,
  raw: string,
  userId?: string
): string {
  // OTP codes are only 6 digits, so the hash is bound to the user. Link tokens are 256-bit
  // and stay addressable by the hash alone.
  const material = purpose === "email_otp" ? `${purpose}:${userId ?? ""}:${raw}` : `${purpose}:${raw}`;
  return createHmac("sha256", requirePepper(config)).update(material).digest("hex");
}

/** True when SES SMTP is actually configured. Placeholder CDK values count as unset. */
export function smtpReady(config: Env): boolean {
  const user = config.SMTP_USERNAME;
  const pass = config.SMTP_PASSWORD;
  return Boolean(
    config.SMTP_HOST &&
      user &&
      user !== "replace-me" &&
      pass &&
      pass !== "replace-me"
  );
}

/**
 * Outside local dev / test, missing SMTP is a hard failure (the code must not be logged
 * as a fallback). In development and test, callers may continue and sendMail no-ops.
 */
export function mailUnavailableInDeployedEnv(config: Env): boolean {
  if (smtpReady(config)) return false;
  return config.NODE_ENV !== "development" && config.NODE_ENV !== "test";
}

function redisKey(kind: "ip" | "addr", value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `auth:recovery:${kind}:${digest}`;
}

/** Per-IP and per-address caps. Fails open when Redis is down, same as login lockout. */
export async function recoveryRateLimited(config: Env, ip: string, email: string): Promise<boolean> {
  const redis = getRedis(config);
  if (!redis) return false;
  try {
    const ipKey = redisKey("ip", ip);
    const addrKey = redisKey("addr", email);
    const ipCount = await redis.incr(ipKey);
    if (ipCount === 1) await redis.expire(ipKey, WINDOW_SECONDS);
    const addrCount = await redis.incr(addrKey);
    if (addrCount === 1) await redis.expire(addrKey, WINDOW_SECONDS);
    return ipCount > IP_LIMIT || addrCount > ADDRESS_LIMIT;
  } catch (err) {
    log.warn("recoveryRateLimited: Redis failed, not limiting", { err });
    return false;
  }
}

export async function clearRecoveryRateLimits(config: Env, ip: string, email: string): Promise<void> {
  const redis = getRedis(config);
  if (!redis) return;
  try {
    await redis.del(redisKey("ip", ip), redisKey("addr", email));
  } catch (err) {
    log.warn("clearRecoveryRateLimits: Redis failed", { err });
  }
}

export async function isPasswordEmailVerified(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ emailVerifiedAt: authIdentities.emailVerifiedAt })
    .from(authIdentities)
    .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, "password")))
    .limit(1);
  return Boolean(row?.emailVerifiedAt);
}

export async function markPasswordEmailVerified(db: Db, userId: string, email: string): Promise<void> {
  const now = new Date();
  const [updated] = await db
    .update(authIdentities)
    .set({ emailVerifiedAt: now, lastUsedAt: now, emailAtLink: email })
    .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, "password")))
    .returning({ id: authIdentities.id });
  if (updated) return;
  await db
    .insert(authIdentities)
    .values({
      userId,
      provider: "password",
      providerSubject: email,
      emailAtLink: email,
      emailVerifiedAt: now,
      lastUsedAt: now,
    })
    .onConflictDoUpdate({
      target: [authIdentities.provider, authIdentities.providerSubject],
      set: { emailVerifiedAt: now, lastUsedAt: now, emailAtLink: email, userId },
    });
}

/** Burns any still-unused token of this purpose, then stores a new hashed one. Returns the raw secret. */
export async function issueVerificationToken(
  db: Db,
  config: Env,
  userId: string,
  purpose: VerificationPurpose
): Promise<string> {
  const raw = purpose === "email_otp" ? generateOtp() : randomBytes(32).toString("base64url");
  const now = new Date();
  await db
    .update(authVerificationTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(authVerificationTokens.userId, userId),
        eq(authVerificationTokens.purpose, purpose),
        isNull(authVerificationTokens.usedAt)
      )
    );
  await db.insert(authVerificationTokens).values({
    userId,
    purpose,
    tokenHash: hashVerificationToken(config, purpose, raw, userId),
    expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
  });
  return raw;
}

/** Same HMAC cost and DB round-trip as a real lookup, so an unknown address is not cheaper to probe. */
export async function burnDummyVerification(
  db: Db | undefined,
  config: Env,
  purpose: VerificationPurpose
): Promise<void> {
  if (!config?.AUTH_REFRESH_TOKEN_PEPPER) return;
  try {
    hashVerificationToken(config, purpose, randomBytes(32).toString("base64url"));
    if (db) {
      await db
        .select({ id: authVerificationTokens.id })
        .from(authVerificationTokens)
        .where(
          and(
            eq(authVerificationTokens.userId, "00000000-0000-0000-0000-000000000000"),
            eq(authVerificationTokens.purpose, purpose)
          )
        )
        .limit(1);
    }
  } catch {
    // Ignore timing probe errors
  }
}

/**
 * Marks a matching unused, unexpired token as used and returns its user id.
 * Expired, unknown, and already-used tokens all return null (callers must not distinguish them).
 */
async function findLiveToken(
  db: Db,
  config: Env,
  purpose: VerificationPurpose,
  raw: string,
  userId?: string
): Promise<{ id: string; userId: string } | null> {
  const tokenHash = hashVerificationToken(config, purpose, raw, userId);
  const now = new Date();
  const [row] = await db
    .select({
      id: authVerificationTokens.id,
      userId: authVerificationTokens.userId,
      expiresAt: authVerificationTokens.expiresAt,
    })
    .from(authVerificationTokens)
    .where(
      and(
        eq(authVerificationTokens.purpose, purpose),
        eq(authVerificationTokens.tokenHash, tokenHash),
        isNull(authVerificationTokens.usedAt)
      )
    )
    .limit(1);
  if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
  return { id: row.id, userId: row.userId };
}

/** Does not mark the token used. Password-policy failures must leave the reset link intact. */
export async function peekVerificationToken(
  db: Db,
  config: Env,
  purpose: VerificationPurpose,
  raw: string,
  userId?: string
): Promise<string | null> {
  const row = await findLiveToken(db, config, purpose, raw, userId);
  return row?.userId ?? null;
}

export async function consumeVerificationToken(
  db: Db,
  config: Env,
  purpose: VerificationPurpose,
  raw: string,
  userId?: string
): Promise<string | null> {
  const row = await findLiveToken(db, config, purpose, raw, userId);
  if (!row) return null;
  const [consumed] = await db
    .update(authVerificationTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(authVerificationTokens.id, row.id), isNull(authVerificationTokens.usedAt)))
    .returning({ userId: authVerificationTokens.userId });
  return consumed?.userId ?? null;
}
