import { Worker, Queue } from "bullmq";
import { createDb } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { purgeExpiredCaptureEvidence } from "../services/enrichment/capture-evidence.js";

const log = createLogger("enrichment-evidence-retention.worker");

const QUEUE_NAME = "enrichment-evidence-retention";

/**
 * ENR-03 — daily retention sweep. Capture-derived Evidence Ledger rows carry a
 * `retention_until`; this removes the ones that have passed it. A fact that is captured again
 * has its retention extended at that point, so only evidence nobody has refreshed expires.
 */
export async function startEnrichmentEvidenceRetentionWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — enrichment evidence retention worker disabled");
    return () => Promise.resolve();
  }
  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — enrichment evidence retention worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });
  // 03:17 UTC daily: off the hour, away from the other sweeps.
  await queue.upsertJobScheduler("enrichment-evidence-retention-daily", { pattern: "17 3 * * *" }, { name: "enrichment-evidence-retention-daily", data: {} });

  const { db, sql } = createDb(config.DATABASE_URL);
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await withSpan("enrichment-evidence-retention.tick", async () => {
        const removed = await purgeExpiredCaptureEvidence(db);
        log.info("expired capture evidence removed", { removed });
      });
    },
    { connection }
  );
  worker.on("failed", (_job, err) => log.error("enrichment evidence retention sweep failed", err));

  return async () => {
    await worker.close();
    await queue.close();
    await sql.end();
  };
}
