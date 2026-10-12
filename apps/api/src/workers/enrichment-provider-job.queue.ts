import { Queue } from "bullmq";
import type { Env } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";

export const ENRICHMENT_PROVIDER_JOB_QUEUE = "skout-enrichment-provider-job";

export interface EnrichmentProviderJobPayload {
  jobId: string;
}

let queue: Queue<EnrichmentProviderJobPayload> | null = null;

export function getEnrichmentProviderJobQueue(config: Env): Queue<EnrichmentProviderJobPayload> {
  if (!queue) {
    queue = new Queue<EnrichmentProviderJobPayload>(ENRICHMENT_PROVIDER_JOB_QUEUE, {
      connection: redisBullMqConnection(config.REDIS_URL),
      defaultJobOptions: {
        // Retries are counted on the enrichment_jobs row, not by the queue: a queue message
        // only asks a worker to look at the job, and the row decides whether it may run.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    queue.on("error", (err) => {
      console.warn(`[bullmq] ${ENRICHMENT_PROVIDER_JOB_QUEUE} queue error:`, err.message);
    });
  }
  return queue;
}

/**
 * Asks a worker to look at a job, now or after `delayMs`. Returns false when there is no
 * queue to ask; the job stays queued in the database and the recovery pass picks it up.
 * A duplicate message is harmless — only one worker can claim the row.
 */
export async function enqueueEnrichmentProviderJob(config: Env, jobId: string, delayMs = 0): Promise<boolean> {
  if (!(await isRedisAvailable(config))) return false;
  try {
    // BullMQ rejects ":" in a custom id; the suffix lets the same job be handed over again later.
    await getEnrichmentProviderJobQueue(config).add("run-provider-job", { jobId }, { jobId: `${jobId}-${Date.now()}`, delay: Math.max(delayMs, 0) });
    return true;
  } catch {
    return false;
  }
}
