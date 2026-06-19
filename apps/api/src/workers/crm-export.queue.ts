import { Queue } from "bullmq";
import type { Env } from "../config/env.js";

export const CRM_EXPORT_QUEUE = "skout-crm-export";

export interface CrmExportJobPayload {
  jobId: string;
  workspaceId: string;
  listId: string;
}

let queue: Queue<CrmExportJobPayload> | null = null;

function redisConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || "6379"),
    password: parsed.password || undefined,
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export function getCrmExportQueue(config: Env): Queue<CrmExportJobPayload> {
  if (!queue) {
    queue = new Queue<CrmExportJobPayload>(CRM_EXPORT_QUEUE, {
      connection: redisConnection(config.REDIS_URL),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return queue;
}

export async function enqueueCrmExportJob(
  config: Env,
  payload: CrmExportJobPayload
): Promise<void> {
  const q = getCrmExportQueue(config);
  await q.add("crm-sync", payload, { jobId: payload.jobId });
}
