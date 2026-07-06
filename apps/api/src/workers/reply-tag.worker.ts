import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { tagReply } from "../services/reply-tagger.service.js";
import { REPLY_TAG_QUEUE, type ReplyTagJobPayload } from "./reply-tag.queue.js";

const log = createLogger("reply-tag.worker");

const { inboxThreads } = schema;

function redisConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || "6379"),
    password: parsed.password || undefined,
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export async function startReplyTagWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL || !config.OPENAI_API_KEY) {
    const reason = !config.DATABASE_URL ? "DATABASE_URL" : "OPENAI_API_KEY";
    log.warn(`Reply-tag worker not started — ${reason} not set`);
    return async () => {};
  }

  const { db, sql } = createDb(config.DATABASE_URL);

  const worker = new Worker<ReplyTagJobPayload>(
    REPLY_TAG_QUEUE,
    async (job) => {
      const { threadId, bodyText } = job.data;

      const tag = await tagReply(bodyText, config.OPENAI_API_KEY);
      if (!tag) {
        log.debug("reply-tag: no tag returned, skipping update", { threadId });
        return;
      }

      await db
        .update(inboxThreads)
        .set({ replyTag: tag, updatedAt: new Date() })
        .where(eq(inboxThreads.id, threadId));

      log.info("reply-tag: thread tagged", { threadId, tag });
    },
    {
      connection: redisConnection(config.REDIS_URL),
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    log.error("reply-tag job failed", err, { jobId: job?.id, threadId: job?.data.threadId });
  });

  log.info("Reply-tag worker started", { queue: REPLY_TAG_QUEUE });

  return async () => {
    await worker.close();
    await sql.end();
  };
}

/** Standalone entrypoint: `node dist/workers/reply-tag.worker.js` */
async function main() {
  const config = loadEnv();
  const stop = await startReplyTagWorker(config);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1]?.includes("reply-tag.worker") ||
  process.env.REPLY_TAG_WORKER_STANDALONE === "true";

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
