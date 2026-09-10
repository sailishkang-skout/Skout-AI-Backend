import { Queue } from "bullmq";
import { injectTraceContext } from "@skout/observability";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";

export const WORKSPACE_RESCORE_QUEUE = "skout-workspace-rescore";

export interface WorkspaceRescoreJobPayload {
  jobId: string;
  workspaceId: string;
  icpVersion: number;
  /** §11.3 Observability — W3C trace-context propagation, same pattern as list-score.queue.ts. */
  traceContext?: Record<string, string>;
}

let queue: Queue<WorkspaceRescoreJobPayload> | null = null;

export function getWorkspaceRescoreQueue(config: Env): Queue<WorkspaceRescoreJobPayload> {
  if (!queue) {
    queue = new Queue<WorkspaceRescoreJobPayload>(WORKSPACE_RESCORE_QUEUE, {
      connection: redisBullMqConnection(config.REDIS_URL),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    });
    queue.on("error", (err) => {
      console.warn(`[bullmq] ${WORKSPACE_RESCORE_QUEUE} queue error:`, err.message);
    });
  }
  return queue;
}

export async function enqueueWorkspaceRescoreJob(
  config: Env,
  payload: WorkspaceRescoreJobPayload
): Promise<void> {
  const q = getWorkspaceRescoreQueue(config);
  await q.add(
    "rescore-workspace",
    { ...payload, traceContext: payload.traceContext ?? injectTraceContext() },
    { jobId: payload.jobId }
  );
}
