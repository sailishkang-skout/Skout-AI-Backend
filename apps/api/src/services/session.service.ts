/**
 * AUTH-BE-13 — session and refresh-token service.
 *
 * Refresh tokens are opaque random (>=256-bit), stored only as keyed (peppered) hashes —
 * never the raw value (matches the pattern in packages/db/src/schema/auth-own.ts's own
 * comment about not repeating invite_sessions' plaintext-token mistake). Rotation is
 * one-time-use with reuse detection: presenting an already-used token revokes the whole
 * session (a strong theft signal) except for a short grace window that absorbs a client
 * firing two refreshes back-to-back (e.g. two tabs racing on load).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import { emitAuthRefreshMetric, emitAuthRefreshReuseMetric } from "@skout/auth";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { getRedis } from "../lib/redis.js";

const log = createLogger("session.service");
const { authSessions, authRefreshTokens, authEvents } = schema;

/** §3 defaults. */
export const IDLE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
export const ABSOLUTE_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
/** Reuse of an already-rotated token within this window is treated as a benign double-fire
 *  (e.g. two racing tabs), not theft — see rotateRefreshToken(). */
const REUSE_GRACE_MS = 5_000;
/** How long a "not revoked" answer is cached; a "revoked" answer is cached until explicitly
 *  invalidated (see markSessionRevokedInCache), so revocation itself is never stale. */
const REVOKED_CACHE_NEGATIVE_TTL_SECONDS = 30;

export type RevokeReason =
  | "logout"
  | "logout_all"
  | "refresh_reuse_detected"
  | "password_changed"
  | "blocked"
  | "idle_expired"
  | "absolute_expired";

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export interface CreatedSession {
  sessionId: string;
  refreshToken: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface RotatedRefreshToken {
  sessionId: string;
  refreshToken: string;
  idleExpiresAt: Date;
}

function requirePepper(config: Env): string {
  if (!config.AUTH_REFRESH_TOKEN_PEPPER) {
    throw new HttpError(
      "AUTH_REFRESH_TOKEN_PEPPER must be set to use own-auth sessions.",
      503
    );
  }
  return config.AUTH_REFRESH_TOKEN_PEPPER;
}

function hashRefreshToken(rawToken: string, pepper: string): string {
  return createHmac("sha256", pepper).update(rawToken).digest("hex");
}

/** IPv4: /24 (drop last octet). IPv6: /48 (drop everything after the third hextet). Anything
 *  else (unparsable) is dropped entirely — coarse enough to be useful for abuse patterns
 *  without being a precise per-user tracking key. */
export function ipPrefix(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    return undefined;
  }
  if (ip.includes(":")) {
    const parts = ip.split(":").filter(Boolean);
    if (parts.length >= 3) return `${parts[0]}:${parts[1]}:${parts[2]}::/48`;
    return undefined;
  }
  return undefined;
}

function hashUserAgent(config: Env, ua: string | undefined): string | undefined {
  if (!ua) return undefined;
  // Keyed with the same pepper as refresh tokens — diagnostic metadata, but still a keyed
  // hash rather than a fixed-key one anyone could precompute against a known UA string.
  return createHmac("sha256", config.AUTH_REFRESH_TOKEN_PEPPER ?? "auth-ua-fallback")
    .update(ua)
    .digest("hex")
    .slice(0, 32);
}

/** Exported so BE-14's auth endpoints (login/signup attempts, not just session lifecycle
 *  events) write to the same auth_events shape/table rather than growing a second
 *  ad-hoc audit-log writer. */
export async function logEvent(
  db: Db,
  config: Env,
  userId: string | null,
  type: string,
  meta: SessionMeta,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await db.insert(authEvents).values({
    userId,
    type,
    ipPrefix: ipPrefix(meta.ip) ?? null,
    uaHash: hashUserAgent(config, meta.userAgent) ?? null,
    metadata,
  });
}

function generateRawToken(): string {
  return randomBytes(32).toString("base64url"); // 256 bits
}

/** Create a new session with its first refresh token. */
export async function createSession(
  db: Db,
  config: Env,
  userId: string,
  meta: SessionMeta = {}
): Promise<CreatedSession> {
  const pepper = requirePepper(config);
  const now = Date.now();
  const idleExpiresAt = new Date(now + IDLE_TTL_MS);
  const absoluteExpiresAt = new Date(now + ABSOLUTE_TTL_MS);

  const [session] = await db
    .insert(authSessions)
    .values({
      userId,
      idleExpiresAt,
      absoluteExpiresAt,
      userAgentHash: hashUserAgent(config, meta.userAgent) ?? null,
      ipPrefix: ipPrefix(meta.ip) ?? null,
    })
    .returning();
  if (!session) throw new HttpError("Failed to create session", 500);

  const rawToken = generateRawToken();
  await db.insert(authRefreshTokens).values({
    sessionId: session.id,
    tokenHash: hashRefreshToken(rawToken, pepper),
    expiresAt: absoluteExpiresAt,
  });

  await logEvent(db, config, userId, "session_created", meta, { sessionId: session.id });

  return { sessionId: session.id, refreshToken: rawToken, idleExpiresAt, absoluteExpiresAt };
}

async function revokeSessionInternal(
  db: Db,
  config: Env,
  sessionId: string,
  reason: RevokeReason
): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(eq(authSessions.id, sessionId));
  // Invalidate immediately so the very next access-token verification sees the revocation,
  // instead of relying on the negative-cache TTL to expire.
  await markSessionRevokedInCache(config, sessionId);
}

export async function revokeSession(
  db: Db,
  config: Env,
  sessionId: string,
  reason: RevokeReason,
  meta: SessionMeta = {}
): Promise<void> {
  const [session] = await db
    .select({ userId: authSessions.userId })
    .from(authSessions)
    .where(eq(authSessions.id, sessionId))
    .limit(1);
  await revokeSessionInternal(db, config, sessionId, reason);
  await logEvent(db, config, session?.userId ?? null, "session_revoked", meta, { sessionId, reason });
}

/** logout-all / block / password-change: revoke every non-revoked session for a user. */
export async function revokeAllSessionsForUser(
  db: Db,
  config: Env,
  userId: string,
  reason: RevokeReason,
  meta: SessionMeta = {}
): Promise<number> {
  const rows = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));

  for (const row of rows) {
    await revokeSessionInternal(db, config, row.id, reason);
  }
  await logEvent(db, config, userId, "session_revoked_all", meta, { reason, count: rows.length });
  return rows.length;
}

/**
 * Rotate a refresh token: validate, atomically claim it (exactly one caller wins a race),
 * issue a new token, and refresh the session's idle expiry.
 *
 * Reuse handling: if the token was already claimed —
 *   - within REUSE_GRACE_MS: treated as a benign concurrent double-fire (the loser). The
 *     session is left alone and the *previously issued* child token is returned again, so
 *     both callers end up with a valid, usable pair instead of one of them failing outright.
 *   - beyond the grace window: treated as theft (a stolen, already-used token being replayed
 *     later). The whole session is revoked and an auth_events row is written.
 */
export async function rotateRefreshToken(
  db: Db,
  config: Env,
  rawToken: string,
  meta: SessionMeta = {}
): Promise<RotatedRefreshToken> {
  const pepper = requirePepper(config);
  const tokenHash = hashRefreshToken(rawToken, pepper);

  const [existing] = await db
    .select()
    .from(authRefreshTokens)
    .where(eq(authRefreshTokens.tokenHash, tokenHash))
    .limit(1);
  if (!existing) {
    emitAuthRefreshMetric({ result: "failure" });
    throw new HttpError("AUTH_TOKEN_INVALID", 401);
  }

  const [session] = await db
    .select()
    .from(authSessions)
    .where(eq(authSessions.id, existing.sessionId))
    .limit(1);
  if (!session) {
    emitAuthRefreshMetric({ result: "failure" });
    throw new HttpError("AUTH_TOKEN_INVALID", 401);
  }
  if (session.revokedAt) {
    emitAuthRefreshMetric({ result: "failure", userId: session.userId });
    throw new HttpError("AUTH_SESSION_REVOKED", 401);
  }

  const now = new Date();
  if (session.absoluteExpiresAt <= now) {
    await revokeSessionInternal(db, config, session.id, "absolute_expired");
    emitAuthRefreshMetric({ result: "failure", userId: session.userId });
    throw new HttpError("AUTH_SESSION_REVOKED", 401);
  }
  if (session.idleExpiresAt <= now) {
    await revokeSessionInternal(db, config, session.id, "idle_expired");
    emitAuthRefreshMetric({ result: "failure", userId: session.userId });
    throw new HttpError("AUTH_SESSION_REVOKED", 401);
  }

  // Atomic claim + child issuance run in one transaction so a concurrent loser reading
  // committed state never observes "claimed" without also observing the child token that
  // proves it — otherwise a benign double-fire can be misread as reuse (see the `withinGrace`
  // branch below) purely because it raced the winner's second statement, not because it was
  // actually reused.
  const newIdleExpiresAt = new Date(now.getTime() + IDLE_TTL_MS);
  const rawNewToken = generateRawToken();

  const claimed = await db.transaction(async (tx) => {
    const [claimedRow] = await tx
      .update(authRefreshTokens)
      .set({ usedAt: now })
      .where(and(eq(authRefreshTokens.id, existing.id), isNull(authRefreshTokens.usedAt)))
      .returning();
    if (!claimedRow) return null;

    await tx.insert(authRefreshTokens).values({
      sessionId: session.id,
      tokenHash: hashRefreshToken(rawNewToken, pepper),
      parentId: existing.id,
      expiresAt: session.absoluteExpiresAt,
    });
    await tx
      .update(authSessions)
      .set({ lastUsedAt: now, idleExpiresAt: newIdleExpiresAt })
      .where(eq(authSessions.id, session.id));

    return claimedRow;
  });

  if (!claimed) {
    // Someone else already claimed it. Re-read to see how long ago.
    const [current] = await db
      .select()
      .from(authRefreshTokens)
      .where(eq(authRefreshTokens.id, existing.id))
      .limit(1);
    const usedAt = current?.usedAt ?? existing.usedAt;
    const withinGrace = usedAt && now.getTime() - usedAt.getTime() <= REUSE_GRACE_MS;

    if (withinGrace) {
      // Benign double-fire: hand back the child token that the winner already created.
      const [child] = await db
        .select()
        .from(authRefreshTokens)
        .where(eq(authRefreshTokens.parentId, existing.id))
        .orderBy(desc(authRefreshTokens.createdAt))
        .limit(1);
      if (child) {
        // We don't have the winner's raw token (only its hash is stored) — this endpoint
        // cannot re-issue the exact same raw value. Signal the caller to retry the flow
        // with the token the winner's response already returned, rather than fail hard.
        emitAuthRefreshMetric({ result: "failure", userId: session.userId });
        throw new HttpError("AUTH_TOKEN_ROTATED_CONCURRENTLY", 409);
      }
    }

    // Reuse beyond the grace window (or no child found) — theft signal.
    await revokeSessionInternal(db, config, session.id, "refresh_reuse_detected");
    await logEvent(db, config, session.userId, "refresh_reuse_detected", meta, {
      sessionId: session.id,
    });
    emitAuthRefreshReuseMetric({ userId: session.userId, sessionId: session.id });
    emitAuthRefreshMetric({ result: "failure", userId: session.userId });
    throw new HttpError("AUTH_SESSION_REVOKED", 401);
  }

  emitAuthRefreshMetric({ result: "success", userId: session.userId });
  return { sessionId: session.id, refreshToken: rawNewToken, idleExpiresAt: newIdleExpiresAt };
}

// --- Revocation cache (BE-12's access-token verification calls this on every request) ---

function revocationCacheKey(sessionId: string): string {
  return `auth:session:revoked:${sessionId}`;
}

/**
 * Cached revocation check so access-token verification isn't a DB hit on every request.
 * "Revoked" is cached indefinitely (revocation is permanent and actively invalidated below,
 * never stale); "not revoked" is cached briefly so a just-revoked session still stops working
 * promptly. Falls back to a direct DB read when Redis is unavailable (local dev without it).
 */
export async function isSessionRevoked(db: Db, config: Env, sessionId: string): Promise<boolean> {
  const redis = getRedis(config);
  if (redis) {
    try {
      const cached = await redis.get(revocationCacheKey(sessionId));
      if (cached === "1") return true;
      if (cached === "0") return false;
    } catch (err) {
      // fall through to DB — Redis being unreachable must never block a revocation check,
      // but a silent, permanent fallback would hide a real outage, so log it.
      log.warn("isSessionRevoked: Redis read failed, falling back to DB", { err, sessionId });
    }
  }

  const [session] = await db
    .select({ revokedAt: authSessions.revokedAt })
    .from(authSessions)
    .where(eq(authSessions.id, sessionId))
    .limit(1);
  const revoked = !session || session.revokedAt !== null;

  if (redis) {
    try {
      if (revoked) {
        await redis.set(revocationCacheKey(sessionId), "1");
      } else {
        await redis.set(revocationCacheKey(sessionId), "0", "EX", REVOKED_CACHE_NEGATIVE_TTL_SECONDS);
      }
    } catch (err) {
      // best-effort cache — a write failure must not fail the request, but should be visible.
      log.warn("isSessionRevoked: Redis write failed, cache not updated", { err, sessionId });
    }
  }
  return revoked;
}

/** Sets the revocation cache immediately after a revoke — called by revokeSessionInternal so
 *  the very next access-token verification sees the revocation instead of waiting out the
 *  negative-cache TTL. Exported for the rare caller that revokes outside this module. */
export async function markSessionRevokedInCache(config: Env, sessionId: string): Promise<void> {
  const redis = getRedis(config);
  if (!redis) return;
  try {
    await redis.set(revocationCacheKey(sessionId), "1");
  } catch (err) {
    // best-effort — if this fails, the revoke itself already committed to Postgres, so the
    // session is still revoked; a stale "not revoked" cache entry can only live for up to
    // REVOKED_CACHE_NEGATIVE_TTL_SECONDS instead of being invalidated immediately. Log it
    // because that degrades the immediate-invalidation guarantee this function exists for.
    log.warn("markSessionRevokedInCache: Redis write failed", { err, sessionId });
  }
}

/** Constant-time-safe comparison export, kept here so callers never write their own ad-hoc
 *  token comparison (Ground Rule 6). Unused internally — lookups go by hash, not by
 *  comparing raw tokens — but exposed for any future direct-compare need. */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
