import { Queue } from "bullmq";
import type { Env } from "../config/env.js";
import { redisBullMqConnection } from "../lib/redis.js";

export const AUTOMATION_RUN_QUEUE = "skout-automation-run";

export interface AutomationRunAdvancePayload {
  automationRunId: string;
  workspaceId: string;
}

let queue: Queue<AutomationRunAdvancePayload> | null = null;

export function getAutomationRunQueue(config: Env): Queue<AutomationRunAdvancePayload> {
  if (!queue) {
    queue = new Queue<AutomationRunAdvancePayload>(AUTOMATION_RUN_QUEUE, {
      connection: redisBullMqConnection(config.REDIS_URL),
      defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: false },
    });
  }
  return queue;
}

/** Enqueues one "advance this run by one step" job. */
export async function enqueueAutomationRunAdvance(config: Env, payload: AutomationRunAdvancePayload) {
  await getAutomationRunQueue(config).add("advance", payload);
}
