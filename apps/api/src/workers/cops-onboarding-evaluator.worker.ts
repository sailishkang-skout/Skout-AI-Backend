import { Worker, Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { runOnboardingEvaluator } from "../services/cops-onboarding-signals.service.js";
import { reportPlatformOpsMetrics } from "../services/cops-ops-metrics.service.js";
import { enqueueSequenceAdvanceJob } from "./sequence-enrollment.queue.js";

const log = createLogger("cops-onboarding-evaluator.worker");

const QUEUE_NAME = "cops-onboarding-evaluator";
/** Every 10 minutes: the shortest trigger (no delivery) is 1 hour, so 10 minutes is close enough. */
const CRON = "*/10 * * * *";

/**
 * COPS-05 scheduled onboarding evaluator: activation from product data, stalled-onboarding playbooks,
 * follow-up stop triggers, CS handoff, and the WelcomeEmailSent safety sweep. Each rule is idempotent
 * (unique rows), so a re-run or two workers never duplicate a task.
 */
export async function startCopsOnboardingEvaluatorWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — onboarding evaluator disabled");
    return () => Promise.resolve();
  }
  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — onboarding evaluator disabled");
    return () => Promise.resolve();
  }
  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.upsertJobScheduler("cops-onboarding-evaluator", { pattern: CRON }, { name: "cops-onboarding-evaluator", data: {} });
  const { db } = createDb(config.DATABASE_URL);
  const deps = {
    config,
    scheduleFirstStep: async (e: { enrollmentId: string; workspaceId: string; prospectId: string; sequenceId: string; firstStepAt: Date | null }) => {
      const delayMs = config.BYPASS_BUSINESS_HOURS || !e.firstStepAt ? 0 : Math.max(0, e.firstStepAt.getTime() - Date.now());
      await enqueueSequenceAdvanceJob(config, { enrollmentId: e.enrollmentId, workspaceId: e.workspaceId, prospectId: e.prospectId, sequenceId: e.sequenceId }, delayMs);
    },
  };
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await withSpan("cops-onboarding-evaluator.tick", async () => {
        const result = await runOnboardingEvaluator(db, deps, randomUUID());
        log.info("onboarding evaluator pass finished", result);
      });
      // COPS-07: the same tick reports the platform health numbers that the log monitors alert on.
      // A failure here must not fail the evaluator job.
      await reportPlatformOpsMetrics(db, log).catch((err) => log.error("cops ops metrics report failed", { err }));
    },
    { connection, concurrency: 1 }
  );
  worker.on("failed", (job, err) => log.error("Onboarding evaluator job failed", { jobId: job?.id, err }));
  log.info(`Onboarding evaluator worker started (cron: ${CRON})`);
  return async () => {
    await worker.close();
    await queue.close();
  };
}
