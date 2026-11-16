import { Queue, Worker } from "bullmq";
import { createDb } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { runAutoCapturePass } from "../services/enrichment/capture-auto.service.js";
import { DB_SHUTDOWN_TIMEOUT_SECONDS } from "../plugins/db.js";

const log = createLogger("capture-auto.worker");

const QUEUE_NAME = "skout-capture-auto";
const EVERY_MS = 60 * 1000;

/**
 * ENR-02 — automatic people capture. Every minute, reads one batch (up to 250 people) of each
 * due automatic capture job through the Unipile connector; with or without Redis.
 */
export async function startCaptureAutoWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — automatic capture worker disabled");
    return async () => {};
  }
  if (!config.UNIPILE_DSN || !config.UNIPILE_API_KEY) {
    log.info("Unipile not configured — automatic capture worker disabled");
    return async () => {};
  }
  const { db, sql } = createDb(config.DATABASE_URL);
  let running = false;
  const pass = async () => {
    // Passes never overlap: a slow batch delays the next pass instead of doubling up.
    if (running) return;
    running = true;
    try {
      const ran = await withSpan("capture-auto.pass", () => runAutoCapturePass(db, config));
      if (ran) log.info("automatic capture pass", { jobs: ran });
    } catch (err) {
      log.error("automatic capture pass failed", err);
    } finally {
      running = false;
    }
  };

  if (!(await isRedisAvailable(config))) {
    const timer = setInterval(() => void pass(), EVERY_MS);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await sql.end({ timeout: DB_SHUTDOWN_TIMEOUT_SECONDS });
    };
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.upsertJobScheduler("capture-auto", { every: EVERY_MS }, { name: "capture-auto", data: {}, opts: { removeOnComplete: true, removeOnFail: 10 } });
  // One job at a time across all API instances (BullMQ hands each scheduled job to one worker).
  const worker = new Worker(QUEUE_NAME, async () => void (await pass()), { connection, concurrency: 1 });
  worker.on("failed", (_job, err) => log.error("automatic capture job failed", err));
  return async () => {
    await worker.close();
    await queue.close();
    await sql.end({ timeout: DB_SHUTDOWN_TIMEOUT_SECONDS });
  };
}
