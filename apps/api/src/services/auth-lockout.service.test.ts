import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { getRedis } from "../lib/redis.js";
import {
  clearIpFailures,
  isIpLocked,
  recordIpFailureAndCheckLocked,
} from "./auth-lockout.service.js";

/** Exercises the Redis-backed IP lockout path against a real Redis instance (not the fail-open
 *  fallback) — confirms the counter actually increments, locks past the threshold, and that
 *  clearing/expiring it un-locks. Skips itself (rather than failing) if Redis isn't reachable in
 *  this environment, since the service is explicitly designed to degrade gracefully without one. */
describe("auth-lockout.service (real Redis)", () => {
  const config = loadEnv();
  let redisAvailable = false;
  const testIp = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

  beforeAll(async () => {
    const redis = getRedis(config);
    if (!redis) return;
    try {
      if (redis.status === "wait") await redis.connect();
      await redis.ping();
      redisAvailable = true;
    } catch {
      redisAvailable = false;
    }
  });

  afterEach(async () => {
    await clearIpFailures(config, testIp);
  });

  afterAll(async () => {
    const redis = getRedis(config);
    await redis?.quit().catch(() => undefined);
  });

  it("is not locked before any failures are recorded", async () => {
    if (!redisAvailable) return;
    expect(await isIpLocked(config, testIp)).toBe(false);
  });

  it("locks the IP only after crossing the failure threshold, using a real Redis counter", async () => {
    if (!redisAvailable) return;

    // 20 failures is the threshold (IP_FAILURE_THRESHOLD) — the 20th call must still report
    // "not locked" (count > threshold, not >=), and the 21st must flip it.
    let lastResult = false;
    for (let i = 0; i < 20; i++) {
      lastResult = await recordIpFailureAndCheckLocked(config, testIp);
    }
    expect(lastResult).toBe(false);
    expect(await isIpLocked(config, testIp)).toBe(false);

    lastResult = await recordIpFailureAndCheckLocked(config, testIp);
    expect(lastResult).toBe(true);
    expect(await isIpLocked(config, testIp)).toBe(true);

    // Verify against the raw Redis key too, so this isn't just testing itself in a circle.
    const redis = getRedis(config)!;
    const raw = await redis.get(`auth:lockout:ip:${createHash("sha256").update(testIp).digest("hex").slice(0, 32)}`);
    expect(Number(raw)).toBe(21);
  });

  it("clearIpFailures resets the counter so the IP is no longer locked", async () => {
    if (!redisAvailable) return;
    for (let i = 0; i < 22; i++) {
      await recordIpFailureAndCheckLocked(config, testIp);
    }
    expect(await isIpLocked(config, testIp)).toBe(true);

    await clearIpFailures(config, testIp);
    expect(await isIpLocked(config, testIp)).toBe(false);
  });

  it("a distinct IP has its own independent counter", async () => {
    if (!redisAvailable) return;
    const otherIp = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
    try {
      for (let i = 0; i < 25; i++) {
        await recordIpFailureAndCheckLocked(config, testIp);
      }
      expect(await isIpLocked(config, testIp)).toBe(true);
      expect(await isIpLocked(config, otherIp)).toBe(false);
    } finally {
      await clearIpFailures(config, otherIp);
    }
  });
});
