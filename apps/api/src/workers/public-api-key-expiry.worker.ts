import { Worker, Queue } from "bullmq";
import { createDb } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { sendMail } from "../services/mail.service.js";
import { dispatchWebhookEvent } from "../services/webhook.service.js";
import { runKeyExpiryReminders } from "../services/public-api-key-expiry.service.js";

const log = createLogger("public-api-key-expiry.worker");

const QUEUE_NAME = "public-api-key-expiry";
/** Daily at 08:00 UTC. */
const CRON = "0 8 * * *";

/** PAPI-022: daily API key expiry reminders (14 and 3 days) and `api_key.expired` events. */
export async function startPublicApiKeyExpiryWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — API key expiry worker disabled");
    return () => Promise.resolve();
  }
  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — API key expiry worker disabled");
    return () => Promise.resolve();
  }
  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.upsertJobScheduler("public-api-key-expiry-daily", { pattern: CRON }, { name: "public-api-key-expiry-daily", data: {} });
  const { db } = createDb(config.DATABASE_URL);
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await withSpan("public-api-key-expiry.tick", async () => {
        const result = await runKeyExpiryReminders(db, {
          sendMail: (opts) => sendMail(config, opts),
          dispatchWebhook: (eventType, workspaceId, payload) => dispatchWebhookEvent(db, config, eventType, workspaceId, payload),
          appUrl: config.INVITE_BASE_URL ?? config.FRONTEND_URL,
        });
        log.info("API key expiry reminders finished", { sent: result.reminders.length });
      });
    },
    { connection, concurrency: 1 }
  );
  worker.on("failed", (job, err) => log.error("API key expiry job failed", { jobId: job?.id, err }));
  log.info(`API key expiry worker started (cron: ${CRON})`);
  return async () => {
    await worker.close();
    await queue.close();
  };
}
