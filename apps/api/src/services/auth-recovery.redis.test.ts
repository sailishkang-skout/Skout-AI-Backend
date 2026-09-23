import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { getRedis } from "../lib/redis.js";
import {
  ADDRESS_LIMIT,
  IP_LIMIT,
  clearRecoveryRateLimits,
  recoveryRateLimited,
} from "./auth-recovery.service.js";

function key(kind: "ip" | "addr", value: string): string {
  return `auth:recovery:${kind}:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

/** Real Redis counters for AUTH-BE-15 send limits. Skips when Redis is not reachable. */
describe("auth-recovery rate limit (real Redis)", () => {
  const config = loadEnv();
  let redisAvailable = false;
  const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
  const email = `be15-redis-${Date.now()}@example.test`;
  const extraEmails: string[] = [];
  const extraIps: string[] = [];

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
    await clearRecoveryRateLimits(config, ip, email);
    for (const other of extraEmails) await clearRecoveryRateLimits(config, ip, other);
    for (const otherIp of extraIps) await clearRecoveryRateLimits(config, otherIp, email);
    extraEmails.length = 0;
    extraIps.length = 0;
  });

  afterAll(async () => {
    const redis = getRedis(config);
    await redis?.quit().catch(() => undefined);
  });

  it("locks an address on the 6th send and leaves a different address alone", async () => {
    if (!redisAvailable) return;
    const otherEmail = `be15-redis-other-${Date.now()}@example.test`;
    const otherIp = `198.51.100.${Math.floor(Math.random() * 50) + 201}`;
    extraEmails.push(otherEmail);
    extraIps.push(otherIp);

    let limited = false;
    for (let i = 0; i < ADDRESS_LIMIT; i++) {
      limited = await recoveryRateLimited(config, ip, email);
    }
    expect(limited).toBe(false);

    limited = await recoveryRateLimited(config, ip, email);
    expect(limited).toBe(true);

    expect(await recoveryRateLimited(config, otherIp, otherEmail)).toBe(false);

    const redis = getRedis(config)!;
    expect(Number(await redis.get(key("addr", email)))).toBe(ADDRESS_LIMIT + 1);
    const ttl = await redis.ttl(key("addr", email));
    expect(ttl).toBeGreaterThan(0);
  });

  it("locks an IP after 20 sends even when each send uses a new address", async () => {
    if (!redisAvailable) return;
    let limited = false;
    for (let i = 0; i < IP_LIMIT; i++) {
      const next = `be15-redis-ip-${i}-${Date.now()}@example.test`;
      extraEmails.push(next);
      limited = await recoveryRateLimited(config, ip, next);
    }
    expect(limited).toBe(false);

    const last = `be15-redis-ip-last-${Date.now()}@example.test`;
    extraEmails.push(last);
    limited = await recoveryRateLimited(config, ip, last);
    expect(limited).toBe(true);

    const redis = getRedis(config)!;
    expect(Number(await redis.get(key("ip", ip)))).toBe(IP_LIMIT + 1);
  });
});
