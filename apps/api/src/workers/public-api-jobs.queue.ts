import { Queue } from "bullmq";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";

/** PAPI-058: public API batch jobs (api_jobs rows), run by public-api-jobs.worker.ts. */
export const PUBLIC_API_JOBS_QUEUE = "skout-public-api-jobs";

export interface PublicApiJobPayload {
  jobId: string;
}

let queue: Queue<PublicApiJobPayload> | null = null;

export function getPublicApiJobsQueue(config: Env): Queue<PublicApiJobPayload> {
  if (!queue) {
    queue = new Queue<PublicApiJobPayload>(PUBLIC_API_JOBS_QUEUE, {
      connection: redisBullMqConnection(config.REDIS_URL),
      // The runner claims a job once (queued → running), so a retry of a started job does nothing.
      defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 500, removeOnFail: 500 },
    });
    queue.on("error", (err) => {
      console.warn(`[bullmq] ${PUBLIC_API_JOBS_QUEUE} queue error:`, err.message);
    });
  }
  return queue;
}

export async function enqueuePublicApiJob(config: Env, payload: PublicApiJobPayload): Promise<void> {
  await getPublicApiJobsQueue(config).add("run", payload, { jobId: payload.jobId });
}
