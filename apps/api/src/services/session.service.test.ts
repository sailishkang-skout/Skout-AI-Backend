import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as redisLib from "../lib/redis.js";
import { createDb, schema } from "@skout/db";
import { eq } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import {
  ABSOLUTE_TTL_MS,
  IDLE_TTL_MS,
  createSession,
  ipPrefix,
  isSessionRevoked,
  revokeAllSessionsForUser,
  revokeSession,
  rotateRefreshToken,
} from "./session.service.js";

const { users, authSessions, authRefreshTokens, authEvents } = schema;

describe("session.service", () => {
  const config = { ...loadEnv(), AUTH_REFRESH_TOKEN_PEPPER: "test-pepper-do-not-use-in-prod" };
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  let userId: string;
  const cleanupSessionIds: string[] = [];

  beforeAll(async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `session-service-test-${Date.now()}@example.test`, status: "active" })
      .returning();
    userId = user!.id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // auth_refresh_tokens / auth_events cascade or are independently scoped — clean explicitly.
    for (const sessionId of cleanupSessionIds) {
      await db.delete(authRefreshTokens).where(eq(authRefreshTokens.sessionId, sessionId));
      await db.delete(authSessions).where(eq(authSessions.id, sessionId));
    }
    cleanupSessionIds.length = 0;
    await db.delete(authEvents).where(eq(authEvents.userId, userId));
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, userId));
    await sql.end();
  });

  describe("ipPrefix", () => {
    it("truncates IPv4 to a /24", () => {
      expect(ipPrefix("203.0.113.42")).toBe("203.0.113.0/24");
    });
    it("truncates IPv6 to a /48", () => {
      expect(ipPrefix("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48");
    });
    it("returns undefined for unparsable input", () => {
      expect(ipPrefix("not-an-ip")).toBeUndefined();
      expect(ipPrefix(undefined)).toBeUndefined();
    });
  });

  describe("createSession", () => {
    it("creates a session with a usable refresh token and correct TTLs", async () => {
      const before = Date.now();
      const session = await createSession(db, config, userId, { ip: "203.0.113.7", userAgent: "vitest" });
      cleanupSessionIds.push(session.sessionId);

      expect(session.refreshToken).toHaveLength(43); // base64url(32 bytes)
      expect(session.idleExpiresAt.getTime()).toBeGreaterThanOrEqual(before + IDLE_TTL_MS - 1000);
      expect(session.absoluteExpiresAt.getTime()).toBeGreaterThanOrEqual(before + ABSOLUTE_TTL_MS - 1000);

      const [row] = await db.select().from(authSessions).where(eq(authSessions.id, session.sessionId)).limit(1);
      expect(row?.userId).toBe(userId);
      expect(row?.revokedAt).toBeNull();

      const [tokenRow] = await db
        .select()
        .from(authRefreshTokens)
        .where(eq(authRefreshTokens.sessionId, session.sessionId))
        .limit(1);
      // The raw token is never stored — only its hash.
      expect(tokenRow?.tokenHash).not.toBe(session.refreshToken);
      expect(tokenRow?.tokenHash).toHaveLength(64); // sha256 hex
    });

    it("throws a clear error when AUTH_REFRESH_TOKEN_PEPPER is not configured", async () => {
      await expect(
        createSession(db, { ...config, AUTH_REFRESH_TOKEN_PEPPER: undefined }, userId)
      ).rejects.toThrow(HttpError);
    });
  });

  describe("rotateRefreshToken", () => {
    it("rotates: the old token stops working, the new one works, idle expiry advances", async () => {
      const session = await createSession(db, config, userId);
      cleanupSessionIds.push(session.sessionId);

      const rotated = await rotateRefreshToken(db, config, session.refreshToken);
      expect(rotated.sessionId).toBe(session.sessionId);
      expect(rotated.refreshToken).not.toBe(session.refreshToken);
      expect(rotated.idleExpiresAt.getTime()).toBeGreaterThan(session.idleExpiresAt.getTime() - 1000);

      // New token rotates again cleanly.
      const rotatedAgain = await rotateRefreshToken(db, config, rotated.refreshToken);
      expect(rotatedAgain.sessionId).toBe(session.sessionId);
    });

    it("rejects an unknown token", async () => {
      await expect(rotateRefreshToken(db, config, "not-a-real-token")).rejects.toMatchObject({
        message: "AUTH_TOKEN_INVALID",
      });
    });

    it("reuse beyond the grace window revokes the whole session (theft signal)", async () => {
      const session = await createSession(db, config, userId);
      cleanupSessionIds.push(session.sessionId);

      const rotated = await rotateRefreshToken(db, config, session.refreshToken);
      expect(rotated).toBeTruthy();

      // Simulate the grace window having passed by backdating the used_at on the old token row.
      const original = (
        await db.select().from(authRefreshTokens).where(eq(authRefreshTokens.sessionId, session.sessionId))
      ).find((r) => r.parentId === null)!;
      await db
        .update(authRefreshTokens)
        .set({ usedAt: new Date(Date.now() - 60_000) })
        .where(eq(authRefreshTokens.id, original.id));

      // Replaying the original (already-rotated, now "old") token should be treated as theft.
      await expect(rotateRefreshToken(db, config, session.refreshToken)).rejects.toMatchObject({
        message: "AUTH_SESSION_REVOKED",
      });

      const [sessionRow] = await db.select().from(authSessions).where(eq(authSessions.id, session.sessionId)).limit(1);
      expect(sessionRow?.revokedAt).not.toBeNull();
      expect(sessionRow?.revokedReason).toBe("refresh_reuse_detected");

      // The new (legitimately rotated) token is also dead now — the whole session is revoked.
      await expect(rotateRefreshToken(db, config, rotated.refreshToken)).rejects.toMatchObject({
        message: "AUTH_SESSION_REVOKED",
      });

      const [event] = await db
        .select()
        .from(authEvents)
        .where(eq(authEvents.type, "refresh_reuse_detected"))
        .limit(1);
      expect(event?.userId).toBe(userId);
    });

    it("concurrent rotation of the same token: exactly one wins", async () => {
      const session = await createSession(db, config, userId);
      cleanupSessionIds.push(session.sessionId);

      const results = await Promise.allSettled([
        rotateRefreshToken(db, config, session.refreshToken),
        rotateRefreshToken(db, config, session.refreshToken),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // The loser gets a distinct "retry" signal, not a session-killing error — within the
      // grace window a benign double-fire must not revoke the session.
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        message: "AUTH_TOKEN_ROTATED_CONCURRENTLY",
      });

      const [sessionRow] = await db.select().from(authSessions).where(eq(authSessions.id, session.sessionId)).limit(1);
      expect(sessionRow?.revokedAt).toBeNull();
    });

    it("rejects rotation on an already-revoked session", async () => {
      const session = await createSession(db, config, userId);
      cleanupSessionIds.push(session.sessionId);
      await revokeSession(db, config, session.sessionId, "logout");

      await expect(rotateRefreshToken(db, config, session.refreshToken)).rejects.toMatchObject({
        message: "AUTH_SESSION_REVOKED",
      });
    });

    it("idle-expired session is revoked and rotation is refused", async () => {
      const session = await createSession(db, config, userId);
      cleanupSessionIds.push(session.sessionId);
      await db
        .update(authSessions)
        .set({ idleExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(authSessions.id, session.sessionId));

      await expect(rotateRefreshToken(db, config, session.refreshToken)).rejects.toMatchObject({
        message: "AUTH_SESSION_REVOKED",
      });
      const [row] = await db.select().from(authSessions).where(eq(authSessions.id, session.sessionId)).limit(1);
      expect(row?.revokedReason).toBe("idle_expired");
    });

    it("absolute-expired session is revoked and rotation is refused", async () => {
      const session = await createSession(db, config, userId);
      cleanupSessionIds.push(session.sessionId);
      await db
        .update(authSessions)
        .set({ absoluteExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(authSessions.id, session.sessionId));

      await expect(rotateRefreshToken(db, config, session.refreshToken)).rejects.toMatchObject({
        message: "AUTH_SESSION_REVOKED",
      });
      const [row] = await db.select().from(authSessions).where(eq(authSessions.id, session.sessionId)).limit(1);
      expect(row?.revokedReason).toBe("absolute_expired");
    });
  });

  describe("revokeSession / revokeAllSessionsForUser", () => {
    it("revokeSession marks the session revoked and writes an auth_events row", async () => {
      const session = await createSession(db, config, userId);
      cleanupSessionIds.push(session.sessionId);

      await revokeSession(db, config, session.sessionId, "logout");

      const [row] = await db.select().from(authSessions).where(eq(authSessions.id, session.sessionId)).limit(1);
      expect(row?.revokedAt).not.toBeNull();
      expect(row?.revokedReason).toBe("logout");

      const events = await db.select().from(authEvents).where(eq(authEvents.type, "session_revoked"));
      expect(events.some((e) => e.userId === userId)).toBe(true);
    });

    it("revokeAllSessionsForUser revokes every non-revoked session and leaves already-revoked ones alone", async () => {
      const s1 = await createSession(db, config, userId);
      const s2 = await createSession(db, config, userId);
      const s3 = await createSession(db, config, userId);
      cleanupSessionIds.push(s1.sessionId, s2.sessionId, s3.sessionId);
      await revokeSession(db, config, s3.sessionId, "logout"); // already revoked before the bulk call

      const count = await revokeAllSessionsForUser(db, config, userId, "password_changed");
      expect(count).toBe(2); // s1, s2 — s3 was already revoked and excluded from the count

      for (const id of [s1.sessionId, s2.sessionId]) {
        const [row] = await db.select().from(authSessions).where(eq(authSessions.id, id)).limit(1);
        expect(row?.revokedReason).toBe("password_changed");
      }
    });
  });

  describe("isSessionRevoked", () => {
    it("returns false for a live session and true after it's revoked", async () => {
      const session = await createSession(db, config, userId);
      cleanupSessionIds.push(session.sessionId);

      expect(await isSessionRevoked(db, config, session.sessionId)).toBe(false);

      await revokeSession(db, config, session.sessionId, "logout");

      expect(await isSessionRevoked(db, config, session.sessionId)).toBe(true);
    });

    it("returns true for a nonexistent session id (fail closed)", async () => {
      expect(await isSessionRevoked(db, config, "00000000-0000-0000-0000-000000000000")).toBe(true);
    });

    it("caches a live session answer in Redis so the second check does not refill the cache", async () => {
      const cache = new Map<string, string>();
      const redis = {
        get: vi.fn(async (key: string) => cache.get(key) ?? null),
        set: vi.fn(async (key: string, value: string) => {
          cache.set(key, value);
        }),
      };
      vi.spyOn(redisLib, "getRedis").mockReturnValue(redis as never);

      const session = await createSession(db, config, userId);
      cleanupSessionIds.push(session.sessionId);

      expect(await isSessionRevoked(db, config, session.sessionId)).toBe(false);
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(cache.get(`auth:session:revoked:${session.sessionId}`)).toBe("0");

      expect(await isSessionRevoked(db, config, session.sessionId)).toBe(false);
      expect(redis.get).toHaveBeenCalledTimes(2);
      expect(redis.set).toHaveBeenCalledTimes(1);
    });
  });
});
