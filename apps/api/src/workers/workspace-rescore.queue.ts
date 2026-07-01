import { Queue } from "bullmq";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";

export const WORKSPACE_RESCORE_QUEUE = "skout-workspace-rescore";

export interface WorkspaceRescoreJobPayload {
  jobId: string;
  workspaceId: string;
  icpVersion: number;
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
  }
  return queue;
}

export async function enqueueWorkspaceRescoreJob(
  config: Env,
  payload: WorkspaceRescoreJobPayload
): Promise<void> {
  const q = getWorkspaceRescoreQueue(config);
  await q.add("rescore-workspace", payload, { jobId: payload.jobId });
}
