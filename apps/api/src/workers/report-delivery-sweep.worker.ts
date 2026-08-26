import { Worker, Queue } from "bullmq";
import { and, eq, lte } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { deliverReportSchedule } from "../services/report-delivery.service.js";

const log = createLogger("report-delivery-sweep.worker");

const QUEUE_NAME = "report-delivery-sweep";

type Db = ReturnType<typeof createDb>["db"];

/** 8.15 — delivers every report_schedule whose nextSendAt has passed. */
export async function runReportDeliverySweep(
  db: Db,
  config: Env
): Promise<{ delivered: number; failed: number }> {
  const { reportSchedules } = schema;
  const due = await db
    .select()
    .from(reportSchedules)
    .where(and(eq(reportSchedules.enabled, true), lte(reportSchedules.nextSendAt, new Date())));

  let delivered = 0;
  let failed = 0;
  for (const schedule of due) {
    try {
      const result = await deliverReportSchedule(db, config, schedule.workspaceId, schedule.id);
      delivered += 1;
      log.info("Delivered scheduled report", {
        scheduleId: schedule.id,
        workspaceId: schedule.workspaceId,
        emailed: result.emailed,
        skipped: result.skipped,
        version: result.snapshot.version,
      });
    } catch (err) {
      failed += 1;
      log.error("Failed to deliver scheduled report", err, {
        scheduleId: schedule.id,
        workspaceId: schedule.workspaceId,
      });
    }
  }
  return { delivered, failed };
}

export async function startReportDeliverySweepWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — report delivery sweep worker disabled");
    return () => Promise.resolve();
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — report delivery sweep worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });

  const cronExpression = `*/${config.REPORT_DELIVERY_SWEEP_INTERVAL_MINUTES} * * * *`;
  await queue.upsertJobScheduler(
    "report-delivery-sweep-all",
    { pattern: cronExpression },
    { name: "report-delivery-sweep-all", data: {} }
  );

  const { db } = createDb(config.DATABASE_URL);

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const { delivered, failed } = await runReportDeliverySweep(db, config);
      if (delivered || failed) {
        log.info(`Report delivery sweep: delivered ${delivered}, failed ${failed}`);
      }
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("Report delivery sweep job failed", { jobId: job?.id, err });
  });

  log.info(`Report delivery sweep worker started (cron: ${cronExpression})`);

  return async () => {
    await worker.close();
    await queue.close();
  };
}

if (
  process.argv[1]?.endsWith("report-delivery-sweep.worker.ts") ||
  process.argv[1]?.endsWith("report-delivery-sweep.worker.js")
) {
  const config = loadEnv();
  startReportDeliverySweepWorker(config).then(() => {
    log.info("Report delivery sweep worker running standalone");
  });
}
