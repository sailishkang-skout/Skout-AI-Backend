import { Queue } from "bullmq";
import { injectTraceContext } from "@skout/observability";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";

export const CRM_EXPORT_QUEUE = "skout-crm-export";

export interface CrmExportJobPayload {
  jobId: string;
  workspaceId: string;
  listId: string;
  /** §11.3 Observability — W3C trace-context propagation, same pattern as list-score.queue.ts. */
  traceContext?: Record<string, string>;
}

let queue: Queue<CrmExportJobPayload> | null = null;

export function getCrmExportQueue(config: Env): Queue<CrmExportJobPayload> {
  if (!queue) {
    queue = new Queue<CrmExportJobPayload>(CRM_EXPORT_QUEUE, {
      connection: redisBullMqConnection(config.REDIS_URL),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
    queue.on("error", (err) => {
      console.warn(`[bullmq] ${CRM_EXPORT_QUEUE} queue error:`, err.message);
    });
  }
  return queue;
}

export async function enqueueCrmExportJob(
  config: Env,
  payload: CrmExportJobPayload
): Promise<void> {
  const q = getCrmExportQueue(config);
  await q.add(
    "crm-sync",
    { ...payload, traceContext: payload.traceContext ?? injectTraceContext() },
    { jobId: payload.jobId }
  );
}
