import { Worker, Queue } from "bullmq";
import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { createDb, schema, scopedTo } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { recordSignal } from "../services/signal.service.js";

const log = createLogger("risk-decay-sweep.worker");

const QUEUE_NAME = "risk-decay-sweep";
const LOOKBACK_DAYS = 90;

type Db = ReturnType<typeof createDb>["db"];

export interface EngagementRecency {
  lastActivityAt: Date | null;
  eventCount: number;
}

/**
 * R18.1 — recency/frequency of engagement events for one prospect, from the activity data
 * Skout already has: sequence step sends and inbox message activity (either direction — a
 * prospect that keeps getting emailed but never opens/replies is exactly the decay case).
 */
export async function computeEngagementRecency(
  db: Db,
  workspaceId: string,
  prospectId: string
): Promise<EngagementRecency> {
  const { sequenceEnrollmentSteps, sequenceEnrollments, inboxMessages, inboxThreads } = schema;
  const lookbackCutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const stepEvents = await db
    .select({ at: sequenceEnrollmentSteps.executedAt })
    .from(sequenceEnrollmentSteps)
    .innerJoin(sequenceEnrollments, eq(sequenceEnrollments.id, sequenceEnrollmentSteps.enrollmentId))
    .where(
      scopedTo(sequenceEnrollments, workspaceId, eq(sequenceEnrollments.prospectId, prospectId), isNotNull(sequenceEnrollmentSteps.executedAt), gte(sequenceEnrollmentSteps.executedAt, lookbackCutoff))
    );

  const messageEvents = await db
    .select({ at: inboxMessages.sentAt })
    .from(inboxMessages)
    .innerJoin(inboxThreads, eq(inboxThreads.id, inboxMessages.threadId))
    .where(
      scopedTo(inboxThreads, workspaceId, eq(inboxThreads.prospectId, prospectId), gte(inboxMessages.sentAt, lookbackCutoff))
    );

  const allDates = [
    ...stepEvents.map((e) => e.at).filter((d): d is Date => d != null),
    ...messageEvents.map((e) => e.at).filter((d): d is Date => d != null),
  ];

  if (allDates.length === 0) return { lastActivityAt: null, eventCount: 0 };

  const lastActivityAt = allDates.reduce((max, d) => (d > max ? d : max), allDates[0]!);
  return { lastActivityAt, eventCount: allDates.length };
}

function formatReason(daysInactive: number, lastActivityAt: Date | null, eventCount: number): string {
  if (!lastActivityAt) {
    return `No opens, replies, or sequence activity recorded in the last ${LOOKBACK_DAYS} days.`;
  }
  const frequency = eventCount <= 1 ? " — only a single touch in that window" : ` (${eventCount} touches in the last ${LOOKBACK_DAYS} days, none recent)`;
  return `No opens, replies, or activity in ${daysInactive} days (last activity: ${lastActivityAt.toISOString().slice(0, 10)})${frequency}.`;
}

export async function sweepWorkspaceForDecay(
  db: Db,
  workspaceId: string,
  inactivityDays: number
): Promise<number> {
  const { prospectActivations, signals } = schema;
  const now = new Date();
  const inactivityCutoff = new Date(now.getTime() - inactivityDays * 24 * 60 * 60 * 1000);

  const activations = await db
    .select({ prospectId: prospectActivations.prospectId, activatedAt: prospectActivations.activatedAt })
    .from(prospectActivations)
    .where(scopedTo(prospectActivations, workspaceId));

  let flagged = 0;

  for (const activation of activations) {
    // Too new to judge as decayed yet — give it the inactivity window before flagging.
    if (activation.activatedAt > inactivityCutoff) continue;

    const { lastActivityAt, eventCount } = await computeEngagementRecency(db, workspaceId, activation.prospectId);
    const isDecayed = !lastActivityAt || lastActivityAt < inactivityCutoff;
    if (!isDecayed) continue;

    // Avoid re-flagging the same prospect every sweep tick — one engagement_decay signal per
    // inactivity window is enough of a timeline entry.
    const [recent] = await db
      .select({ detectedAt: signals.detectedAt })
      .from(signals)
      .where(
        and(
          eq(signals.entityType, "prospect"),
          eq(signals.entityId, activation.prospectId),
          eq(signals.signalType, "engagement_decay")
        )
      )
      .orderBy(desc(signals.detectedAt))
      .limit(1);
    if (recent && recent.detectedAt > inactivityCutoff) continue;

    const daysInactive = lastActivityAt
      ? Math.round((now.getTime() - lastActivityAt.getTime()) / (24 * 60 * 60 * 1000))
      : LOOKBACK_DAYS;
    const score = Math.min(1, daysInactive / (inactivityDays * 3));

    await recordSignal(db, {
      entityType: "prospect",
      entityId: activation.prospectId,
      signalType: "engagement_decay",
      reason: formatReason(daysInactive, lastActivityAt, eventCount),
      score,
      source: "risk-decay-sweep",
    });
    flagged++;
  }

  return flagged;
}

export async function startRiskDecaySweepWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — risk decay sweep worker disabled");
    return () => Promise.resolve();
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — risk decay sweep worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });

  const cronExpression = `0 */${config.RISK_DECAY_SWEEP_INTERVAL_HOURS} * * *`;
  await queue.upsertJobScheduler(
    "risk-decay-sweep-all",
    { pattern: cronExpression },
    { name: "risk-decay-sweep-all", data: {} }
  );

  const { db } = createDb(config.DATABASE_URL);
  const { workspaces } = schema;

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      // §11.3 Task 33 — self-triggered on a cron schedule; root span (no upstream trace exists).
      await withSpan("risk-decay-sweep.tick", async () => {
        const allWorkspaces = await db.select({ id: workspaces.id }).from(workspaces);
        let totalFlagged = 0;
        for (const ws of allWorkspaces) {
          try {
            totalFlagged += await sweepWorkspaceForDecay(db, ws.id, config.RISK_DECAY_INACTIVITY_DAYS);
          } catch (err) {
            log.error(`Risk decay sweep failed for workspace ${ws.id}`, { workspaceId: ws.id, err });
          }
        }
        if (totalFlagged > 0) log.info(`Risk decay sweep flagged ${totalFlagged} prospect(s)`);
      });
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("Risk decay sweep job failed", { jobId: job?.id, err });
  });

  log.info(`Risk decay sweep worker started (cron: ${cronExpression})`);

  return async () => {
    await worker.close();
    await queue.close();
  };
}

if (
  process.argv[1]?.endsWith("risk-decay-sweep.worker.ts") ||
  process.argv[1]?.endsWith("risk-decay-sweep.worker.js")
) {
  const config = loadEnv();
  startRiskDecaySweepWorker(config).then(() => {
    log.info("Risk decay sweep worker running standalone");
  });
}
