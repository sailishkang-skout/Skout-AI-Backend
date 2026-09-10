import { Redis } from "ioredis";
import type { Env } from "../config/env.js";

let client: Redis | null = null;
let connectFailed = false;
let availabilityChecked = false;
let redisReachable = false;

/** BullMQ connection options from REDIS_URL. */
export function redisBullMqConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || "6379"),
    password: parsed.password || undefined,
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

/** Shared Redis client — returns null when unavailable (local dev without Redis). */
export function getRedis(config: Env): Redis | null {
  if (connectFailed || !config.REDIS_URL) return null;
  if (client) return client;

  try {
    const parsed = new URL(config.REDIS_URL);
    client = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      lazyConnect: true,
      ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
    });
    client.on("error", () => {
      connectFailed = true;
      redisReachable = false;
      availabilityChecked = true;
    });
    return client;
  } catch {
    connectFailed = true;
    return null;
  }
}

/** Ping Redis once per process and verify it meets BullMQ's minimum version (5.0.0). */
export async function isRedisAvailable(config: Env): Promise<boolean> {
  if (!config.REDIS_URL) return false;
  if (availabilityChecked) return redisReachable;

  const redis = getRedis(config);
  if (!redis) {
    availabilityChecked = true;
    redisReachable = false;
    return false;
  }

  try {
    if (redis.status === "wait") await redis.connect();
    const info = await redis.info("server");
    const versionMatch = info.match(/redis_version:(\S+)/);
    if (versionMatch) {
      const parts = versionMatch[1].split(".").map(Number);
      const major = parts[0] ?? 0;
      const minor = parts[1] ?? 0;
      if (major < 5 || (major === 5 && minor < 0)) {
        console.warn(
          `[redis] Redis ${versionMatch[1]} is below BullMQ minimum (5.0.0) — workers disabled.`
        );
        redisReachable = false;
        availabilityChecked = true;
        return false;
      }
    }
    redisReachable = true;
  } catch {
    connectFailed = true;
    redisReachable = false;
  }
  availabilityChecked = true;
  return redisReachable;
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  await client.quit().catch(() => undefined);
  client = null;
}
