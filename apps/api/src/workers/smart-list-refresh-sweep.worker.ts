import { Worker, Queue } from "bullmq";
import { and, eq, isNull, lte, ne, or } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { computeNextRefreshAt, type SmartListRefreshCadence } from "../services/smart-list-cadence.js";
import { enqueueSmartListRefreshJob } from "./smart-list-refresh.queue.js";

const log = createLogger("smart-list-refresh-sweep.worker");

const QUEUE_NAME = "smart-list-refresh-sweep";

export async function startSmartListRefreshSweepWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — smart list refresh sweep worker disabled");
    return () => Promise.resolve();
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — smart list refresh sweep worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });

  const cronExpression = `*/${config.SMART_LIST_REFRESH_SWEEP_INTERVAL_MINUTES} * * * *`;
  await queue.upsertJobScheduler(
    "smart-list-refresh-sweep-all",
    { pattern: cronExpression },
    { name: "smart-list-refresh-sweep-all", data: {} }
  );

  const { db } = createDb(config.DATABASE_URL);
  const { smartLists, asyncJobs } = schema;

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const now = new Date();
      const due = await db
        .select()
        .from(smartLists)
        .where(
          and(
            ne(smartLists.refreshCadence, "off"),
            or(isNull(smartLists.nextRefreshAt), lte(smartLists.nextRefreshAt, now))
          )
        );

      if (due.length === 0) {
        log.debug("No smart lists due for auto-refresh");
        return;
      }

      log.info(`Enqueuing auto-refresh for ${due.length} smart list(s)`);

      for (const list of due) {
        try {
          // Claim the slot immediately so a slow-running refresh can't be double-enqueued
          // by the next sweep tick before it completes.
          const cadence = list.refreshCadence as SmartListRefreshCadence;
          await db
            .update(smartLists)
            .set({ nextRefreshAt: computeNextRefreshAt(cadence, now) })
            .where(eq(smartLists.id, list.id));

          const [job] = await db
            .insert(asyncJobs)
            .values({
              workspaceId: list.workspaceId,
              jobType: "smart_list_refresh",
              entityType: "smart_list",
              entityId: list.id,
              payload: { cadence },
            })
            .returning();

          await enqueueSmartListRefreshJob(config, {
            jobId: job.id,
            workspaceId: list.workspaceId,
            listId: list.id,
          });
        } catch (err) {
          log.error(`Failed to enqueue refresh for smart list ${list.id}`, { listId: list.id, err });
        }
      }
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("Smart list refresh sweep job failed", { jobId: job?.id, err });
  });

  log.info(`Smart list refresh sweep worker started (cron: ${cronExpression})`);

  return async () => {
    await worker.close();
    await queue.close();
  };
}

if (
  process.argv[1]?.endsWith("smart-list-refresh-sweep.worker.ts") ||
  process.argv[1]?.endsWith("smart-list-refresh-sweep.worker.js")
) {
  const config = loadEnv();
  startSmartListRefreshSweepWorker(config).then(() => {
    log.info("Smart list refresh sweep worker running standalone");
  });
}
