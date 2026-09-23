/**
 * AUTH-BE-14 — brute-force lockout for login/signup, by IP and by account identifier.
 *
 * Two independent layers:
 * - Per-account: `user_credentials.failed_attempts` / `locked_until` (BE-10's schema) — durable,
 *   survives Redis being unavailable, and is what actually protects a given account.
 * - Per-IP: Redis counters here — catches credential-stuffing across many accounts from one
 *   source, which a per-account counter alone can't see. Fails open (never blocks) when Redis
 *   is unreachable, matching session.service.ts's revocation-cache philosophy: a cache/counter
 *   outage must degrade a defense-in-depth layer, not take login down entirely.
 */
import { createHash } from "node:crypto";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { getRedis } from "../lib/redis.js";

const log = createLogger("auth-lockout.service");

/** After this many failures from one IP within the window, the IP is locked out. */
const IP_FAILURE_THRESHOLD = 20;
const IP_WINDOW_SECONDS = 15 * 60; // 15 minutes
const IP_LOCK_SECONDS = 15 * 60;

/** Per-account lockout: escalating backoff, not a single fixed window. */
const ACCOUNT_FAILURE_THRESHOLD = 5;
const ACCOUNT_LOCK_SECONDS = 5 * 60;

function ipCounterKey(ip: string): string {
  // Hash rather than store the raw IP as a Redis key — low sensitivity, but consistent with
  // the "don't need PII in infra you don't have to" default used elsewhere in this ticket set.
  return `auth:lockout:ip:${createHash("sha256").update(ip).digest("hex").slice(0, 32)}`;
}

/** Records one failed attempt from an IP; returns true if that IP is now locked out. */
export async function recordIpFailureAndCheckLocked(config: Env, ip: string): Promise<boolean> {
  const redis = getRedis(config);
  if (!redis) return false; // fail open — no Redis, no IP-level lockout, account-level still applies.
  try {
    const key = ipCounterKey(ip);
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, IP_WINDOW_SECONDS);
    }
    return count > IP_FAILURE_THRESHOLD;
  } catch (err) {
    log.warn("recordIpFailureAndCheckLocked: Redis failed, treating as not locked", { err });
    return false;
  }
}

export async function isIpLocked(config: Env, ip: string): Promise<boolean> {
  const redis = getRedis(config);
  if (!redis) return false;
  try {
    const count = await redis.get(ipCounterKey(ip));
    return count !== null && Number(count) > IP_FAILURE_THRESHOLD;
  } catch (err) {
    log.warn("isIpLocked: Redis failed, treating as not locked", { err });
    return false;
  }
}

export async function clearIpFailures(config: Env, ip: string): Promise<void> {
  const redis = getRedis(config);
  if (!redis) return;
  try {
    await redis.del(ipCounterKey(ip));
  } catch (err) {
    log.warn("clearIpFailures: Redis failed", { err });
  }
}

export { ACCOUNT_FAILURE_THRESHOLD, ACCOUNT_LOCK_SECONDS, IP_LOCK_SECONDS };
