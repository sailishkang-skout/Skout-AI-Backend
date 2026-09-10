import { Worker, Queue } from "bullmq";
import { asc, eq, isNull } from "drizzle-orm";
import { createDb, schema, scopedTo } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { createNotification } from "../services/notifications.service.js";

const log = createLogger("signal-alert-sweep.worker");

const QUEUE_NAME = "signal-alert-sweep";
const BATCH_SIZE = 200;

type Db = ReturnType<typeof createDb>["db"];
type SignalRow = typeof schema.signals.$inferSelect;

/** Human title + body for a signal_alert notification, driven by what the signal actually carries. */
export function describeSignal(signal: Pick<SignalRow, "signalType" | "value">): { title: string; body: string } {
  const value = (signal.value ?? {}) as { reason?: string; detail?: string; score?: number };
  const label = signal.signalType.replace(/_/g, " ");
  if (value.reason) {
    return { title: `New ${label} signal`, body: value.reason };
  }
  if (value.detail) {
    return { title: `New ${label} signal`, body: value.detail };
  }
  return { title: `New ${label} signal`, body: `A ${label} signal was detected.` };
}

/**
 * R17.3 — for one signal row, find every (workspace, owning SDR) pair with an activated
 * prospect at that entity, and notify the owner if the workspace has a matching, enabled
 * alert_rule. Company-level signals (from the corpus ingestor) can fan out to several
 * workspaces/owners; prospect-level signals (risk flags from R18) usually match exactly one.
 */
export async function matchAndNotifySignal(db: Db, config: Env, signal: SignalRow): Promise<number> {
  const { prospectActivations, alertRules } = schema;

  const ownerColumn =
    signal.entityType === "prospect" ? prospectActivations.prospectId : prospectActivations.companyId;

  const owners = await db
    .select({ workspaceId: prospectActivations.workspaceId, ownerId: prospectActivations.ownerId })
    .from(prospectActivations)
    .where(eq(ownerColumn, signal.entityId));

  const seen = new Set<string>();
  let notified = 0;

  for (const owner of owners) {
    const key = `${owner.workspaceId}:${owner.ownerId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const [rule] = await db
      .select()
      .from(alertRules)
      .where(
        scopedTo(alertRules, owner.workspaceId, eq(alertRules.signalType, signal.signalType), eq(alertRules.enabled, true))
      )
      .limit(1);
    if (!rule) continue;
    if (rule.minConfidence != null && (signal.confidence == null || signal.confidence < rule.minConfidence)) {
      continue;
    }

    const { title, body } = describeSignal(signal);
    await createNotification(db, config, {
      workspaceId: owner.workspaceId,
      userId: owner.ownerId,
      type: "signal_alert",
      entityType: signal.entityType,
      entityId: signal.entityId,
      title,
      body,
    });
    notified++;
  }

  return notified;
}

export async function startSignalAlertSweepWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — signal alert sweep worker disabled");
    return () => Promise.resolve();
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — signal alert sweep worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });

  const cronExpression = `*/${config.ALERT_SWEEP_INTERVAL_MINUTES} * * * *`;
  await queue.upsertJobScheduler(
    "signal-alert-sweep-all",
    { pattern: cronExpression },
    { name: "signal-alert-sweep-all", data: {} }
  );

  const { db } = createDb(config.DATABASE_URL);
  const { signals } = schema;

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      // §11.3 Task 33 — self-triggered on a cron schedule; root span (no upstream trace exists).
      await withSpan("signal-alert-sweep.tick", async () => {
        const pending = await db
          .select()
          .from(signals)
          .where(isNull(signals.alertedAt))
          .orderBy(asc(signals.createdAt))
          .limit(BATCH_SIZE);

        if (pending.length === 0) return;

        let totalNotified = 0;
        for (const signal of pending) {
          try {
            totalNotified += await matchAndNotifySignal(db, config, signal);
          } catch (err) {
            log.error(`Failed to match/notify for signal ${signal.id}`, { signalId: signal.id, err });
          } finally {
            // Always mark processed, matched or not, so a permanently-unmatched signal
            // (no rule, no owner) doesn't get re-scanned by every sweep tick forever.
            await db.update(signals).set({ alertedAt: new Date() }).where(eq(signals.id, signal.id));
          }
        }

        log.info(`Signal alert sweep processed ${pending.length} signal(s), sent ${totalNotified} notification(s)`);
      });
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("Signal alert sweep job failed", { jobId: job?.id, err });
  });

  log.info(`Signal alert sweep worker started (cron: ${cronExpression})`);

  return async () => {
    await worker.close();
    await queue.close();
  };
}

if (
  process.argv[1]?.endsWith("signal-alert-sweep.worker.ts") ||
  process.argv[1]?.endsWith("signal-alert-sweep.worker.js")
) {
  const config = loadEnv();
  startSignalAlertSweepWorker(config).then(() => {
    log.info("Signal alert sweep worker running standalone");
  });
}
