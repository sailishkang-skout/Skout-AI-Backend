import { Redis } from "ioredis";
import type { Env } from "../config/env.js";

let client: Redis | null = null;
let connectFailed = false;

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
    });
    return client;
  } catch {
    connectFailed = true;
    return null;
  }
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  await client.quit().catch(() => undefined);
  client = null;
}
