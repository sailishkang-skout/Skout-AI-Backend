import { Worker, Queue } from "bullmq";
import { createDb, schema } from "@skout/db";
import { and, eq } from "drizzle-orm";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";

const log = createLogger("warmup-ramp.worker");

const QUEUE_NAME = "warmup-ramp";

/**
 * Daily send limit schedule:
 * Day 1-7:   +5/day   (5 → 35)
 * Day 8-14:  +10/day  (45 → 105)
 * Day 15+:   +20/day  (125 → WARMUP_MAX_DAILY_LIMIT)
 */
function computeDailyLimit(warmupDay: number, maxLimit: number): number {
  let limit: number;
  if (warmupDay <= 7) {
    limit = warmupDay * 5;
  } else if (warmupDay <= 14) {
    limit = 7 * 5 + (warmupDay - 7) * 10;
  } else {
    limit = 7 * 5 + 7 * 10 + (warmupDay - 14) * 20;
  }
  return Math.min(limit, maxLimit);
}

export async function startWarmupRampWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — warmup ramp worker disabled");
    return () => Promise.resolve();
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — warmup ramp worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });

  // Runs once per day at 00:05 UTC
  await queue.upsertJobScheduler(
    "warmup-daily-ramp",
    { pattern: "5 0 * * *" },
    { name: "warmup-daily-ramp", data: {} }
  );

  const { db } = createDb(config.DATABASE_URL);

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      // §11.3 Task 33 — self-triggered on a cron schedule; root span (no upstream trace exists).
      await withSpan("warmup-ramp.tick", async () => {
        log.info("Starting daily warmup ramp");

        const warmingInboxes = await db
          .select({
            id: schema.inboxes.id,
            warmupDay: schema.inboxes.warmupDay,
            dailySendLimit: schema.inboxes.dailySendLimit,
          })
          .from(schema.inboxes)
          .where(
            and(
              eq(schema.inboxes.warmupStatus, "warming"),
              eq(schema.inboxes.status, "active")
            )
          );

        if (warmingInboxes.length === 0) {
          log.info("No inboxes in warmup");
          return;
        }

        log.info(`Ramping ${warmingInboxes.length} warmup inboxes`);

        const now = new Date();

        for (const inbox of warmingInboxes) {
          const nextDay = inbox.warmupDay + 1;
          const nextLimit = computeDailyLimit(nextDay, config.WARMUP_MAX_DAILY_LIMIT);
          const done = nextDay >= config.WARMUP_MAX_DAYS || nextLimit >= config.WARMUP_MAX_DAILY_LIMIT;

          await db
            .update(schema.inboxes)
            .set({
              warmupDay: nextDay,
              dailySendLimit: nextLimit,
              warmupStatus: done ? "warmed" : "warming",
              updatedAt: now,
            })
            .where(eq(schema.inboxes.id, inbox.id));

          log.info(
            done
              ? `Warmup complete for inbox ${inbox.id} after ${nextDay} days`
              : `Inbox ${inbox.id} ramped to day ${nextDay}, limit ${nextLimit}`,
            { inboxId: inbox.id, day: nextDay, newLimit: nextLimit }
          );
        }
      });
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("Warmup ramp job failed", { jobId: job?.id, err });
  });

  log.info("Warmup ramp worker started (daily at 00:05 UTC)");

  return async () => {
    await worker.close();
    await queue.close();
  };
}

// Allow running directly
if (process.argv[1]?.endsWith("warmup-ramp.worker.ts") || process.argv[1]?.endsWith("warmup-ramp.worker.js")) {
  const config = loadEnv();
  startWarmupRampWorker(config).then(() => {
    log.info("Warmup ramp worker running standalone");
  });
}
