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
    queue.on("error", (err) => {
      console.warn(`[bullmq] ${SEQUENCE_ENROLLMENT_QUEUE} queue error:`, err.message);
    });
  }
  return queue;
}

/**
 * Enqueues a step-advance job.
 * `delayMs` — milliseconds from now until the job fires.
 * `deduplicate` — use a fixed jobId (initial enqueue from route) so double-enrolling
 *   doesn't create duplicate jobs. Pass false for re-enqueues from inside the worker
 *   so a completed job's Redis entry doesn't silently block the new one.
 */
export async function enqueueSequenceAdvanceJob(
  config: Env,
  payload: SeqAdvanceJobPayload,
  delayMs = 0,
  deduplicate = true
): Promise<void> {
  const q = getSequenceEnrollmentQueue(config);
  const jobId = deduplicate
    ? `seq-advance-${payload.enrollmentId}`
    : `seq-advance-${payload.enrollmentId}-${Date.now()}`;
  await q.add("step:advance", payload, {
    jobId,
    delay: Math.max(0, delayMs),
  });
}
