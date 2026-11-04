import { Worker, Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import { runSubscriptionBilling } from "../services/cops-subscriptions.service.js";
import { runRenewals } from "../services/cops-renewals.service.js";
import type { Env } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { runOnboardingEvaluator } from "../services/cops-onboarding-signals.service.js";
import { reportPlatformOpsMetrics } from "../services/cops-ops-metrics.service.js";
import { enqueueSequenceAdvanceJob } from "./sequence-enrollment.queue.js";
import { notifyPassFailures } from "../services/cops-pass-alerts.service.js";
import { runSlaSweep } from "../services/cops-sla-sweep.service.js";
import { runAnalyticsFeed } from "../services/cops-analytics-feed.service.js";
import type { PassFailure } from "../services/cops-subscriptions.service.js";

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
        // COPS-08: bills for periods that have started, and subscription status from unpaid bills.
        // A failing subscription does not stop the pass; failures alert Admin, Owner and Engineering in-app.
        await runSubscriptionBilling(db)
          .then(async (billing) => {
            log.info("subscription billing pass finished", { ...billing, status_changes: billing.status_changes.length, failed: billing.failed.length });
            if (billing.failed.length > 0) {
              log.error("subscription billing pass failed for some subscriptions", { failed: billing.failed });
              await notifyPassFailures(db, "billing", billing.failed);
            }
          })
          .catch((err) => log.error("subscription billing pass failed", { err }));
        const renewalFailures: PassFailure[] = [];
        await runRenewals(db, new Date(), {}, undefined, renewalFailures)
          .then(async (opened) => {
            if (opened.length > 0) log.info("renewal opportunities opened", { count: opened.length });
            if (renewalFailures.length > 0) {
              log.error("renewal pass failed for some subscriptions", { failed: renewalFailures });
              await notifyPassFailures(db, "renewal", renewalFailures);
            }
          })
          .catch((err) => log.error("renewal pass failed", { err }));
      });
      // COPS-12: SLA escalation (at risk before breach, then breach) and clock backfill.
      await runSlaSweep(db)
        .then((r) => (r.atRisk || r.breached || r.backfilled ? log.info("sla sweep finished", r) : undefined))
        .catch((err) => log.error("sla sweep failed", { err }));
      // COPS-13: the warehouse feed sends the published outbox events to PostHog (off without a key).
      await runAnalyticsFeed(db, { apiKey: config.POSTHOG_API_KEY, host: config.POSTHOG_HOST })
        .then((r) => (r.error ? log.warn("analytics feed batch refused", r) : r.sent ? log.info("analytics feed sent", r) : undefined))
        .catch((err) => log.error("analytics feed failed", { err }));
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
