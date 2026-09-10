import { Worker, Queue } from "bullmq";
import { and, eq, gte, lt } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { IncidentsService } from "../services/incidents.service.js";

const log = createLogger("bounce-anomaly-sweep.worker");

const QUEUE_NAME = "bounce-anomaly-sweep";
const BASELINE_DAYS = 7;
const RECENT_HOURS = 24;
const INCIDENT_SOURCE = "bounce-anomaly-sweep";

type Db = ReturnType<typeof createDb>["db"];

export interface BounceWindow {
  sent: number;
  bounces: number;
}

export interface BounceSpikeResult {
  isSpike: boolean;
  recentRate: number;
  baselineRate: number;
  delta: number;
}

/**
 * §11.3 Task ADI-07 — proof-of-concept anomaly detector, first of six categories the vision doc
 * names (bounce/complaint spikes, provider degradation, signal volume drift, quota pacing, model
 * regression, silent pipeline breaks). This is a spike-relative-to-own-baseline check, distinct
 * from INBOX_BOUNCE_RATE_THRESHOLD (inbox-rotation.service.ts's absolute-rate auto-pause) — a
 * workspace can be well under that absolute threshold and still be spiking against its own history.
 */
export function detectBounceSpike(
  recent: BounceWindow,
  baseline: BounceWindow,
  opts: { minSent: number; spikeDelta: number }
): BounceSpikeResult {
  const recentRate = recent.sent > 0 ? recent.bounces / recent.sent : 0;
  const baselineRate = baseline.sent > 0 ? baseline.bounces / baseline.sent : 0;
  const delta = recentRate - baselineRate;

  // Too little volume in either window to trust the comparison — a single bounce out of 2 sends
  // is 50% but tells us nothing statistically.
  if (recent.sent < opts.minSent || baseline.sent < opts.minSent) {
    return { isSpike: false, recentRate, baselineRate, delta };
  }

  return { isSpike: delta >= opts.spikeDelta, recentRate, baselineRate, delta };
}

/** Outbound sends + inbound-classified bounces for one workspace within [since, until). */
export async function getBounceWindow(
  db: Db,
  workspaceId: string,
  since: Date,
  until: Date
): Promise<BounceWindow> {
  const { inboxMessages, inboxThreads, inboxes } = schema;

  const [sentRows, bounceRows] = await Promise.all([
    db
      .select({ id: inboxMessages.id })
      .from(inboxMessages)
      .innerJoin(inboxThreads, eq(inboxMessages.threadId, inboxThreads.id))
      .innerJoin(inboxes, eq(inboxThreads.inboxId, inboxes.id))
      .where(
        and(
          eq(inboxes.workspaceId, workspaceId),
          eq(inboxMessages.direction, "outbound"),
          gte(inboxMessages.sentAt, since),
          lt(inboxMessages.sentAt, until)
        )
      ),
    db
      .select({ id: inboxMessages.id })
      .from(inboxMessages)
      .innerJoin(inboxThreads, eq(inboxMessages.threadId, inboxThreads.id))
      .innerJoin(inboxes, eq(inboxThreads.inboxId, inboxes.id))
      .where(
        and(
          eq(inboxes.workspaceId, workspaceId),
          eq(inboxMessages.direction, "inbound"),
          eq(inboxMessages.classification, "bounce"),
          gte(inboxMessages.sentAt, since),
          lt(inboxMessages.sentAt, until)
        )
      ),
  ]);

  return { sent: sentRows.length, bounces: bounceRows.length };
}

function formatDescription(result: BounceSpikeResult, recent: BounceWindow, baseline: BounceWindow): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return (
    `Bounce rate over the last ${RECENT_HOURS}h is ${pct(result.recentRate)} ` +
    `(${recent.bounces}/${recent.sent} sent) vs a ${BASELINE_DAYS}-day baseline of ${pct(result.baselineRate)} ` +
    `(${baseline.bounces}/${baseline.sent} sent) — a ${pct(result.delta)} increase.`
  );
}

/**
 * Compares one workspace's last-24h bounce rate to its preceding 7-day baseline and opens an
 * incident through the existing incidents infrastructure (not a new, parallel notification path)
 * when the delta crosses BOUNCE_ANOMALY_SPIKE_DELTA. Idempotent per spike episode: skips creating
 * a second incident while an open one from this same source already exists for the workspace.
 *
 * Returns true if a new incident was created.
 */
export async function sweepWorkspaceForBounceSpike(
  db: Db,
  workspaceId: string,
  incidents: IncidentsService,
  config: Pick<Env, "BOUNCE_ANOMALY_MIN_SENT" | "BOUNCE_ANOMALY_SPIKE_DELTA">,
  now = new Date()
): Promise<boolean> {
  const recentSince = new Date(now.getTime() - RECENT_HOURS * 60 * 60 * 1000);
  const baselineSince = new Date(recentSince.getTime() - BASELINE_DAYS * 24 * 60 * 60 * 1000);

  const [recent, baseline] = await Promise.all([
    getBounceWindow(db, workspaceId, recentSince, now),
    getBounceWindow(db, workspaceId, baselineSince, recentSince),
  ]);

  const result = detectBounceSpike(recent, baseline, {
    minSent: config.BOUNCE_ANOMALY_MIN_SENT,
    spikeDelta: config.BOUNCE_ANOMALY_SPIKE_DELTA,
  });
  if (!result.isSpike) return false;

  const openIncidents = await incidents.list(workspaceId, "open");
  if (openIncidents.some((i) => i.source === INCIDENT_SOURCE)) return false;

  await incidents.create({
    workspaceId,
    title: "Bounce rate spike detected",
    severity: result.delta >= config.BOUNCE_ANOMALY_SPIKE_DELTA * 2 ? "critical" : "high",
    source: INCIDENT_SOURCE,
    description: formatDescription(result, recent, baseline),
  });
  return true;
}

export async function startBounceAnomalySweepWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — bounce anomaly sweep worker disabled");
    return () => Promise.resolve();
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — bounce anomaly sweep worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });

  const cronExpression = `0 */${config.BOUNCE_ANOMALY_SWEEP_INTERVAL_HOURS} * * *`;
  await queue.upsertJobScheduler(
    "bounce-anomaly-sweep-all",
    { pattern: cronExpression },
    { name: "bounce-anomaly-sweep-all", data: {} }
  );

  const { db } = createDb(config.DATABASE_URL);
  const { workspaces } = schema;
  const incidents = new IncidentsService(db);

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      // §11.3 Task ADI-07 — self-triggered on a cron schedule; root span (no upstream trace exists).
      await withSpan("bounce-anomaly-sweep.tick", async () => {
        const allWorkspaces = await db.select({ id: workspaces.id }).from(workspaces);
        let totalFlagged = 0;
        for (const ws of allWorkspaces) {
          try {
            if (await sweepWorkspaceForBounceSpike(db, ws.id, incidents, config)) totalFlagged++;
          } catch (err) {
            log.error(`Bounce anomaly sweep failed for workspace ${ws.id}`, { workspaceId: ws.id, err });
          }
        }
        if (totalFlagged > 0) log.info(`Bounce anomaly sweep opened ${totalFlagged} incident(s)`);
      });
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("Bounce anomaly sweep job failed", { jobId: job?.id, err });
  });

  log.info(`Bounce anomaly sweep worker started (cron: ${cronExpression})`);

  return async () => {
    await worker.close();
    await queue.close();
  };
}

if (
  process.argv[1]?.endsWith("bounce-anomaly-sweep.worker.ts") ||
  process.argv[1]?.endsWith("bounce-anomaly-sweep.worker.js")
) {
  const config = loadEnv();
  startBounceAnomalySweepWorker(config).then(() => {
    log.info("Bounce anomaly sweep worker running standalone");
  });
}
