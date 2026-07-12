import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import {
  WEBHOOK_DELIVERY_QUEUE,
  enqueueWebhookDelivery,
  type WebhookDeliveryJobPayload,
} from "./webhook-delivery.queue.js";

const log = createLogger("webhook-delivery.worker");

const { webhookDeliveries } = schema;

/** Retry delays in ms: 30 s, 5 min */
const RETRY_DELAYS_MS = [30_000, 300_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1; // 3 total attempts

/** Build the HMAC-SHA256 signature header value.
 *  Signed string: `<timestamp>.<body>` (Stripe-style, replay-resistant).
 */
export function signPayload(secret: string, timestampSec: number, body: string): string {
  const signed = `${timestampSec}.${body}`;
  return "sha256=" + createHmac("sha256", secret).update(signed).digest("hex");
}

/** Verify an inbound Skout-Webhook signature — useful for receiver-side validation. */
export function verifySignature(
  secret: string,
  timestampSec: number,
  body: string,
  signature: string,
  toleranceSec = 300
): boolean {
  if (Math.abs(Date.now() / 1000 - timestampSec) > toleranceSec) return false;
  const expected = signPayload(secret, timestampSec, body);
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

interface DeliveryResult {
  statusCode: number;
  responseBody: string;
  durationMs: number;
}

async function deliverOnce(
  deliveryId: string,
  job: WebhookDeliveryJobPayload
): Promise<DeliveryResult> {
  const body = JSON.stringify({
    id: job.eventId,
    type: job.eventType,
    workspaceId: job.workspaceId,
    data: job.payload,
    createdAt: new Date().toISOString(),
  });

  const timestampSec = Math.floor(Date.now() / 1000);
  const signature = signPayload(job.secret, timestampSec, body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const start = Date.now();

  try {
    const res = await fetch(job.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-skout-event": job.eventType,
        "x-skout-delivery": deliveryId,
        "x-skout-timestamp": String(timestampSec),
        "x-skout-signature": signature,
        "user-agent": "Skout-Webhook/1.0",
      },
      body,
      signal: controller.signal,
    });
    const responseBody = await res.text().catch(() => "");
    return {
      statusCode: res.status,
      responseBody: responseBody.slice(0, 1000),
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timeout);
  }
}

type DbClient = ReturnType<typeof createDb>["db"];

async function processDelivery(
  db: DbClient,
  config: Env,
  job: WebhookDeliveryJobPayload
): Promise<void> {
  const deliveryId = randomUUID();
  const isLastAttempt = job.attempt >= MAX_ATTEMPTS;

  await db.insert(webhookDeliveries).values({
    id: deliveryId,
    endpointId: job.endpointId,
    workspaceId: job.workspaceId,
    eventType: job.eventType,
    eventId: job.eventId,
    payload: job.payload,
    attempt: job.attempt,
    status: "pending",
  });

  let result: DeliveryResult;
  try {
    result = await deliverOnce(deliveryId, job);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const finalStatus = isLastAttempt ? "dead" : "failed";
    await db
      .update(webhookDeliveries)
      .set({ status: finalStatus, errorMessage: msg })
      .where(eq(webhookDeliveries.id, deliveryId));

    log.warn("Webhook delivery failed", {
      deliveryId,
      endpointId: job.endpointId,
      attempt: job.attempt,
      error: msg,
      finalStatus,
    });

    if (!isLastAttempt) {
      const delayMs = RETRY_DELAYS_MS[job.attempt - 1] ?? 300_000;
      await enqueueWebhookDelivery(config, { ...job, attempt: job.attempt + 1 }, delayMs);
    }
    return;
  }

  const success = result.statusCode >= 200 && result.statusCode < 300;
  const finalStatus = success ? "success" : isLastAttempt ? "dead" : "failed";

  await db
    .update(webhookDeliveries)
    .set({
      status: finalStatus,
      statusCode: result.statusCode,
      responseBody: result.responseBody,
      durationMs: result.durationMs,
      deliveredAt: success ? new Date() : null,
    })
    .where(eq(webhookDeliveries.id, deliveryId));

  log.info("Webhook delivery complete", {
    deliveryId,
    endpointId: job.endpointId,
    attempt: job.attempt,
    statusCode: result.statusCode,
    finalStatus,
  });

  if (!success && !isLastAttempt) {
    const delayMs = RETRY_DELAYS_MS[job.attempt - 1] ?? 300_000;
    await enqueueWebhookDelivery(config, { ...job, attempt: job.attempt + 1 }, delayMs);
  }
}

export async function startWebhookDeliveryWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("Webhook delivery worker not started — DATABASE_URL not set");
    return async () => {};
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Webhook delivery worker not started — Redis unavailable");
    return async () => {};
  }

  const { db, sql } = createDb(config.DATABASE_URL);

  const worker = new Worker<WebhookDeliveryJobPayload>(
    WEBHOOK_DELIVERY_QUEUE,
    async (job) => {
      log.info("Processing webhook:deliver", {
        endpointId: job.data.endpointId,
        eventType: job.data.eventType,
        attempt: job.data.attempt,
      });
      await processDelivery(db, config, job.data);
    },
    {
      connection: redisBullMqConnection(config.REDIS_URL),
      concurrency: 10,
    }
  );

  worker.on("failed", (job, err) => {
    log.error("webhook:deliver job failed unexpectedly", err, {
      endpointId: job?.data?.endpointId,
      eventType: job?.data?.eventType,
    });
  });

  log.info("Webhook delivery worker started", { queue: WEBHOOK_DELIVERY_QUEUE });

  return async () => {
    await worker.close();
    await sql.end();
  };
}

async function main() {
  const config = loadEnv();
  const stop = await startWebhookDeliveryWorker(config);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1]?.includes("webhook-delivery.worker") ||
  process.env.WEBHOOK_DELIVERY_WORKER_STANDALONE === "true";

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
