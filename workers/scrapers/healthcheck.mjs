#!/usr/bin/env node
/** ECS container healthcheck — verifies Redis connectivity for scraper workers. */
import Redis from "ioredis";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";
const redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true });

try {
  await redis.connect();
  const pong = await redis.ping();
  await redis.quit();
  if (pong !== "PONG") process.exit(1);
  process.exit(0);
} catch {
  process.exit(1);
}
