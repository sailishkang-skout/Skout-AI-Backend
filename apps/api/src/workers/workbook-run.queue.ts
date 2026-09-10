import { Queue } from "bullmq";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";

export const WORKBOOK_RUN_QUEUE = "skout-workbook-run";

export interface WorkbookRunJobPayload {
  runId: string;
  workspaceId: string;
}

let queue: Queue<WorkbookRunJobPayload> | null = null;

export function getWorkbookRunQueue(config: Env): Queue<WorkbookRunJobPayload> {
  if (!queue) {
    queue = new Queue<WorkbookRunJobPayload>(WORKBOOK_RUN_QUEUE, {
      connection: redisBullMqConnection(config.REDIS_URL),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    });
    queue.on("error", (err) => {
      console.warn(`[bullmq] ${WORKBOOK_RUN_QUEUE} queue error:`, err.message);
    });
  }
  return queue;
}

/**
 * A pause ends its BullMQ job normally (not a failure) so resume can enqueue a fresh
 * job for the same run — hence the timestamp suffix, since re-adding the exact same
 * jobId after a completed job is a silent no-op in BullMQ, not a re-run.
 */
export async function enqueueWorkbookRunJob(config: Env, payload: WorkbookRunJobPayload): Promise<void> {
  const q = getWorkbookRunQueue(config);
  // BullMQ rejects a custom jobId containing ":" ("Custom Id cannot contain :") — it's
  // reserved for BullMQ's own internal id namespacing.
  await q.add("run-workbook", payload, { jobId: `${payload.runId}-${Date.now()}` });
}
