#!/usr/bin/env node
/**
 * Corpus deploy smoke (R6.1) — verifies Redis, optional SQS schedule queue, and enqueue path.
 *
 * Usage:
 *   REDIS_URL=redis://localhost:6379 node scripts/corpus-deploy-smoke.mjs
 *   SCRAPE_SCHEDULE_QUEUE_URL=https://sqs... node scripts/corpus-deploy-smoke.mjs
 */
import Redis from "ioredis";
import { SQSClient, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { enqueueScrapeJob } from "../workers/scrapers/orchestrator/dist/index.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const sqsUrl = process.env.SCRAPE_SCHEDULE_QUEUE_URL?.trim();

async function checkRedis() {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 5000 });
  const pong = await redis.ping();
  await redis.quit();
  if (pong !== "PONG") throw new Error("Redis ping failed");
  console.log("✓ Redis", redisUrl);
}

async function checkSqs() {
  if (!sqsUrl) {
    console.log("○ SCRAPE_SCHEDULE_QUEUE_URL unset (local dev OK)");
    return;
  }
  const region = process.env.AWS_REGION ?? "us-east-1";
  const client = new SQSClient({ region });
  await client.send(
    new GetQueueAttributesCommand({ QueueUrl: sqsUrl, AttributeNames: ["QueueArn"] })
  );
  console.log("✓ SQS schedule queue reachable");
}

async function enqueueSmoke() {
  const manifest = await enqueueScrapeJob({
    source: "company-web",
    seeds: ["example.com"],
  });
  console.log("✓ Enqueued scrape job", manifest.jobId);
}

await checkRedis();
await checkSqs();
await enqueueSmoke();
console.log("Corpus deploy smoke passed");
