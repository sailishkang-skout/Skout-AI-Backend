import { Queue } from "bullmq";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";
import type { ImportJob, ImportQueue } from "../services/workbook-import-runner.js";

/** Background CSV imports (WB2-020): those over 1,000 rows. */
export const WORKBOOK_IMPORT_QUEUE = "skout-workbook-import";
export const IMPORT_JOB_ATTEMPTS = 5;
const READY_TIMEOUT_MS = 3_000;
const ENQUEUE_TIMEOUT_MS = 5_000;

let queue: Queue<ImportJob> | null = null;

function getQueue(config: Env): Queue<ImportJob> {
  if (!queue) {
    queue = new Queue<ImportJob>(WORKBOOK_IMPORT_QUEUE, {
      connection: redisBullMqConnection(config.REDIS_URL),
      defaultJobOptions: {
        attempts: IMPORT_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: 5_000 },
        // The import record is the history. Keeping a finished job would stop the same import being queued again.
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    queue.on("error", (err) => {
      console.warn(`[bullmq] ${WORKBOOK_IMPORT_QUEUE} queue error:`, err.message);
    });
  }
  return queue;
}

/** With Redis down a queue call waits for it to come back; a request must not. */
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the queue did not answer in time")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function workbookImportQueue(config: Env): ImportQueue {
  return {
    async ready() {
      try {
        // Any answered call shows Redis is there.
        await within(READY_TIMEOUT_MS, getQueue(config).getJobCounts("waiting"));
        return true;
      } catch {
        return false;
      }
    },
    async enqueue(job) {
      // One job per import: adding it again while it is queued or running does nothing.
      await within(ENQUEUE_TIMEOUT_MS, getQueue(config).add("import-csv", job, { jobId: job.importId }));
    },
  };
}

export async function closeWorkbookImportQueue(): Promise<void> {
  const current = queue;
  queue = null;
  await current?.close();
}
