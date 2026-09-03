import { Queue, Worker } from "bullmq";
import { createDb, schema } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { sweepWorkspaceForRetention } from "../services/retention-workflow.service.js";

const log = createLogger("retention-sweep.worker");
const QUEUE_NAME = "retention-sweep";

export async function startRetentionSweepWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — retention sweep worker disabled");
    return () => Promise.resolve();
  }
  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — retention sweep worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });
  const cronExpression = `0 */${config.RETENTION_SWEEP_INTERVAL_HOURS} * * *`;
  await queue.upsertJobScheduler(
    "retention-sweep-all",
    { pattern: cronExpression },
    { name: "retention-sweep-all", data: {} }
  );

  const { db } = createDb(config.DATABASE_URL);
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await withSpan("retention-sweep.tick", async () => {
        const workspaces = await db.select({ id: schema.workspaces.id }).from(schema.workspaces);
        let totalFlagged = 0;
        for (const workspace of workspaces) {
          try {
            totalFlagged += await sweepWorkspaceForRetention(db, config, workspace.id);
          } catch (err) {
            log.error(`Retention sweep failed for workspace ${workspace.id}`, { workspaceId: workspace.id, err });
          }
        }
        if (totalFlagged > 0) log.info(`Retention sweep created ${totalFlagged} flag(s)`);
      });
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("Retention sweep job failed", { jobId: job?.id, err });
  });
  log.info(`Retention sweep worker started (cron: ${cronExpression})`);

  return async () => {
    await worker.close();
    await queue.close();
  };
}

if (
  process.argv[1]?.endsWith("retention-sweep.worker.ts") ||
  process.argv[1]?.endsWith("retention-sweep.worker.js")
) {
  const config = loadEnv();
  startRetentionSweepWorker(config).then(() => log.info("Retention sweep worker running standalone"));
}
