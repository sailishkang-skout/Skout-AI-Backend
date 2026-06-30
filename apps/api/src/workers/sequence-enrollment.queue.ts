import { Queue } from "bullmq";
import type { Env } from "../config/env.js";

export const SEQUENCE_ENROLLMENT_QUEUE = "skout-sequence-enrollment";

/** Payload for a job that advances one enrollment by one step. */
export interface SeqAdvanceJobPayload {
  enrollmentId: string;
  workspaceId: string;
  prospectId: string;
  sequenceId: string;
}

let queue: Queue<SeqAdvanceJobPayload> | null = null;

function redisConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || "6379"),
    password: parsed.password || undefined,
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export function getSequenceEnrollmentQueue(config: Env): Queue<SeqAdvanceJobPayload> {
  if (!queue) {
    queue = new Queue<SeqAdvanceJobPayload>(SEQUENCE_ENROLLMENT_QUEUE, {
      connection: redisConnection(config.REDIS_URL),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 200,
        removeOnFail: 500,
      },
    });
  }
  return queue;
}

/**
 * Enqueues a step-advance job.
 * `delayMs` is the milliseconds from now until the job should be processed
 * (used to fire at the step's scheduledAt time).
 */
export async function enqueueSequenceAdvanceJob(
  config: Env,
  payload: SeqAdvanceJobPayload,
  delayMs = 0
): Promise<void> {
  const q = getSequenceEnrollmentQueue(config);
  // jobId deduplication: one active advance job per enrollment at a time
  const jobId = `seq-advance:${payload.enrollmentId}`;
  await q.add("step:advance", payload, {
    jobId,
    delay: Math.max(0, delayMs),
  });
}
