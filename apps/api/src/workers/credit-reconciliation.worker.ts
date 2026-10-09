import { Worker, Queue } from "bullmq";
import { createDb, reconcileCreditLedger, type Db } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";

const log = createLogger("credit-reconciliation.worker");

const QUEUE_NAME = "credit-reconciliation";
/** Daily at 03:15 UTC. */
const CRON = "15 3 * * *";

/**
 * COPS-04 daily ledger reconciliation (Bible p.40). Compares every wallet balance with the sum of its
 * append-only ledger and the last balance_after, records the run in credit_reconciliation_runs and
 * logs each mismatch as an error for alerting. It never changes a wallet: a mismatch is corrected by
 * a person with a compensating adjustment (runbook: correct credit ledger via compensating entry).
 */
export async function runCreditReconciliation(db: Db, triggeredBy = "schedule") {
  const report = await reconcileCreditLedger(db, { record: true, triggeredBy });
  for (const m of report.mismatches) {
    log.error("credit ledger mismatch", { ...m, runId: report.runId });
  }
  log.info("credit reconciliation finished", {
    runId: report.runId,
    walletsChecked: report.walletsChecked,
    mismatches: report.mismatches.length,
  });
  return report;
}

export async function startCreditReconciliationWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — credit reconciliation worker disabled");
    return () => Promise.resolve();
  }
  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — credit reconciliation worker disabled");
    return () => Promise.resolve();
  }
  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.upsertJobScheduler("credit-reconciliation-daily", { pattern: CRON }, { name: "credit-reconciliation-daily", data: {} });
  const { db } = createDb(config.DATABASE_URL);
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await withSpan("credit-reconciliation.tick", async () => {
        await runCreditReconciliation(db);
      });
    },
    { connection, concurrency: 1 }
  );
  worker.on("failed", (job, err) => log.error("Credit reconciliation job failed", { jobId: job?.id, err }));
  log.info(`Credit reconciliation worker started (cron: ${CRON})`);
  return async () => {
    await worker.close();
    await queue.close();
  };
}
