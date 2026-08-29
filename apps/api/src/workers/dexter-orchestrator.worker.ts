import { Worker } from "bullmq";
import type { SkoutEvent } from "@skout/shared";
import type { Db } from "@skout/db";
import { createDb } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { DEXTER_EVENTS_QUEUE } from "./dexter-events.queue.js";
import { matchTriggers } from "../services/dexter-orchestrator.service.js";
import { proposeDexterPlan, approveDexterPlan, invokeDexterPlan } from "../services/dexter-journey.service.js";

const log = createLogger("dexter-orchestrator.worker");

export async function handleDexterEvent(
  db: Db,
  config: Env,
  event: SkoutEvent<Record<string, unknown>>
): Promise<void> {
  const triggers = await matchTriggers(db, event.tenantId, event.type);
  for (const trigger of triggers) {
    const { plan, policy } = await proposeDexterPlan(db, {
      workspaceId: event.tenantId,
      brief: `Auto-triggered by ${event.type} (trigger ${trigger.id})`,
      actionType: trigger.actionType,
      actionParams: trigger.actionParams,
    });
    log.info("dexter plan proposed from event", { planId: plan.id, eventType: event.type, mode: policy.mode });

    if (policy.mode === "auto") {
      await approveDexterPlan(db, event.tenantId, plan.id);
      await invokeDexterPlan(db, event.tenantId, plan.id);
    }
  }
}

export async function startDexterOrchestratorWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("Dexter orchestrator worker not started — DATABASE_URL not set");
    return async () => {};
  }
  if (!(await isRedisAvailable(config))) {
    log.warn("Dexter orchestrator worker not started — Redis unavailable");
    return async () => {};
  }

  const { db, sql } = createDb(config.DATABASE_URL);

  const worker = new Worker<SkoutEvent<Record<string, unknown>>>(
    DEXTER_EVENTS_QUEUE,
    async (job) => {
      await handleDexterEvent(db, config, job.data);
    },
    { connection: redisBullMqConnection(config.REDIS_URL), concurrency: 5 }
  );

  worker.on("failed", (job, err) => {
    log.error("dexter-orchestrator job failed", err, { eventType: job?.data?.type });
  });

  log.info("Dexter orchestrator worker started", { queue: DEXTER_EVENTS_QUEUE });

  return async () => {
    await worker.close();
    await sql.end();
  };
}

async function main() {
  const config = loadEnv();
  const stop = await startDexterOrchestratorWorker(config);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1]?.includes("dexter-orchestrator.worker") ||
  process.env.DEXTER_ORCHESTRATOR_WORKER_STANDALONE === "true";
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
