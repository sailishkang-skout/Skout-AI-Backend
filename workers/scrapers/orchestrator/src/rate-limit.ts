import { Redis } from "ioredis";

let client: Redis | null = null;

function getRedis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!client) {
    client = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  }
  return client;
}

/** Per-source token bucket using Redis INCR + EXPIRE. Returns false when over cap. */
export async function acquireSourceToken(source: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;

  const envKey = `RATE_LIMIT_${source.toUpperCase().replace(/-/g, "_")}`;
  const max = Number(process.env[envKey] ?? process.env.SCRAPER_RATE_MAX_PER_SOURCE ?? 30);
  const windowSec = Number(process.env.SCRAPER_RATE_WINDOW_SEC ?? 3600);
  const key = `scraper:rate:${source}:${Math.floor(Date.now() / (windowSec * 1000))}`;

  try {
    if (redis.status !== "ready") await redis.connect().catch(() => undefined);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSec);
    return count <= max;
  } catch {
    return true;
  }
}

/** Circuit breaker — pause a source after repeated 429s. */
export async function isSourceCircuitOpen(source: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    if (redis.status !== "ready") await redis.connect().catch(() => undefined);
    const until = await redis.get(`scraper:circuit:${source}`);
    return Boolean(until && Number(until) > Date.now());
  } catch {
    return false;
  }
}

export async function recordSource429(source: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const threshold = Number(process.env.SCRAPER_429_THRESHOLD ?? 5);
  const pauseMs = Number(process.env.SCRAPER_429_PAUSE_MS ?? 15 * 60_000);
  const key = `scraper:429:${source}`;
  try {
    if (redis.status !== "ready") await redis.connect().catch(() => undefined);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 300);
    if (count >= threshold) {
      await redis.set(`scraper:circuit:${source}`, String(Date.now() + pauseMs), "PX", pauseMs);
      await redis.del(key);
    }
  } catch {
    // ignore
  }
}

export async function clearSource429(source: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`scraper:429:${source}`);
  } catch {
    // ignore
  }
}
