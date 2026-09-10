import type { Queue, Worker } from "bullmq";

/** Copy jobs to a dead-letter queue after the final failed attempt. */
export function attachDeadLetterHandler(worker: Worker, dlq: Queue, queueName: string) {
  worker.on("failed", (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return;
    void dlq
      .add(
        "dead",
        {
          queue: queueName,
          bullJobId: job.id,
          data: job.data,
          error: err?.message ?? "unknown",
          failedAt: new Date().toISOString(),
        },
        { removeOnComplete: 1000, removeOnFail: 5000 }
      )
      .catch((e: unknown) => console.error(`[dlq] failed to enqueue from ${queueName}:`, e));
  });
}

export function logRedisMemoryPolicyHint() {
  if (process.env.REDIS_MAXMEMORY_POLICY === "noeviction") return;
  console.warn(
    "[workers] ElastiCache should use maxmemory-policy=noeviction for BullMQ; volatile-lru can evict queued jobs"
  );
}
