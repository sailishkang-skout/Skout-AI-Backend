import { Queue } from "bullmq";
import type { Env } from "../config/env.js";

export const IMAP_POLL_QUEUE = "skout-imap-poll";

export interface ImapPollJobPayload {
  /** When set, only polls this specific inbox. When absent, polls all IMAP-configured inboxes. */
  inboxId?: string;
}

let queue: Queue<ImapPollJobPayload> | null = null;

function redisConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || "6379"),
    password: parsed.password || undefined,
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export function getImapPollQueue(config: Env): Queue<ImapPollJobPayload> {
  if (!queue) {
    queue = new Queue<ImapPollJobPayload>(IMAP_POLL_QUEUE, {
      connection: redisConnection(config.REDIS_URL),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "fixed", delay: 30_000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    });
  }
  return queue;
}

/** Schedule a repeatable poll-all job (every 5 minutes). Safe to call on every startup. */
export async function scheduleImapPolling(config: Env): Promise<void> {
  const q = getImapPollQueue(config);
  await q.upsertJobScheduler("imap:poll-all", { every: 5 * 60 * 1000 }, { name: "imap:poll-all", data: {} });
}
