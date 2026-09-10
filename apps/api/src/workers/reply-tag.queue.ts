import { Queue } from "bullmq";
import { injectTraceContext } from "@skout/observability";
import type { Env } from "../config/env.js";

export const REPLY_TAG_QUEUE = "skout-reply-tag";

export interface ReplyTagJobPayload {
  threadId: string;
  messageId: string;
  workspaceId: string;
  bodyText: string;
  /** §11.3 Observability — W3C trace-context propagation, same pattern as list-score.queue.ts. */
  traceContext?: Record<string, string>;
}

let queue: Queue<ReplyTagJobPayload> | null = null;

function redisConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || "6379"),
    password: parsed.password || undefined,
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export function getReplyTagQueue(config: Env): Queue<ReplyTagJobPayload> {
  if (!queue) {
    queue = new Queue<ReplyTagJobPayload>(REPLY_TAG_QUEUE, {
      connection: redisConnection(config.REDIS_URL),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
    queue.on("error", (err) => {
      console.warn(`[bullmq] ${REPLY_TAG_QUEUE} queue error:`, err.message);
    });
  }
  return queue;
}

/**
 * §11.3 — the sole producer call site (inbound-reply.service.ts) previously called
 * getReplyTagQueue(config).add(...) directly; wrapped here so trace-context injection happens
 * in one place, matching every other queue in this file's family.
 */
export async function enqueueReplyTagJob(config: Env, payload: ReplyTagJobPayload): Promise<void> {
  const q = getReplyTagQueue(config);
  await q.add("tag-reply", { ...payload, traceContext: payload.traceContext ?? injectTraceContext() });
}
