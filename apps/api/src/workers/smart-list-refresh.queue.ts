import { Queue } from "bullmq";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";

export const SMART_LIST_REFRESH_QUEUE = "skout-smart-list-refresh";

export interface SmartListRefreshJobPayload {
  jobId: string;
  workspaceId: string;
  listId: string;
}

let queue: Queue<SmartListRefreshJobPayload> | null = null;

export function getSmartListRefreshQueue(config: Env): Queue<SmartListRefreshJobPayload> {
  if (!queue) {
    queue = new Queue<SmartListRefreshJobPayload>(SMART_LIST_REFRESH_QUEUE, {
      connection: redisBullMqConnection(config.REDIS_URL),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 3000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
    queue.on("error", (err) => {
      console.warn(`[bullmq] ${SMART_LIST_REFRESH_QUEUE} queue error:`, err.message);
    });
  }
  return queue;
}

export async function enqueueSmartListRefreshJob(
  config: Env,
  payload: SmartListRefreshJobPayload
): Promise<void> {
  const q = getSmartListRefreshQueue(config);
  await q.add("refresh-smart-list", payload, { jobId: payload.jobId });
}
