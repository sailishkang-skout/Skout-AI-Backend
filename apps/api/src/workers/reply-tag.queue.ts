import { Queue } from "bullmq";
import type { Env } from "../config/env.js";

export const REPLY_TAG_QUEUE = "skout-reply-tag";

export interface ReplyTagJobPayload {
  threadId: string;
  messageId: string;
  workspaceId: string;
  bodyText: string;
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
  }
  return queue;
}
