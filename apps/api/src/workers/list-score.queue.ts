import { Queue } from "bullmq";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";

export const LIST_SCORE_QUEUE = "skout-list-score";

export interface ListScoreJobPayload {
  jobId: string;
  workspaceId: string;
  listId: string;
}

let queue: Queue<ListScoreJobPayload> | null = null;

export function getListScoreQueue(config: Env): Queue<ListScoreJobPayload> {
  if (!queue) {
    queue = new Queue<ListScoreJobPayload>(LIST_SCORE_QUEUE, {
      connection: redisBullMqConnection(config.REDIS_URL),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 3000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
    queue.on("error", (err) => {
      console.warn(`[bullmq] ${LIST_SCORE_QUEUE} queue error:`, err.message);
    });
  }
  return queue;
}

export async function enqueueListScoreJob(
  config: Env,
  payload: ListScoreJobPayload
): Promise<void> {
  const q = getListScoreQueue(config);
  await q.add("score-list", payload, { jobId: payload.jobId });
}
