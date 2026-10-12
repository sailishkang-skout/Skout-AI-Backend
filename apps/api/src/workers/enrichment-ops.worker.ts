import { Queue, Worker } from "bullmq";
import { createDb, type Db } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { closeAbandonedCaptureRuns, enrichmentOpsSnapshot, evaluateAlerts, type OpsAlert } from "../services/enrichment/ops.service.js";

const log = createLogger("enrichment-ops.worker");

const QUEUE_NAME = "skout-enrichment-ops";
const EVERY_MS = 5 * 60 * 1000;
/** A standing alert is logged again this often, not on every pass. */
const REPEAT_MS = 30 * 60 * 1000;

const lastLogged = new Map<string, number>();

/**
 * One pass: close abandoned capture runs, take the platform snapshot, and log each firing
 * alert at error level (`enrichment alert firing`, with `alert`, `severity`, `value`,
 * `threshold`). Monitors are built on that log line — see docs/runbooks/enrichment.md.
 * An alert that clears is logged once as resolved.
 */
export async function runEnrichmentOpsPass(db: Db, now = new Date()): Promise<OpsAlert[]> {
  const closed = await closeAbandonedCaptureRuns(db, now);
  if (closed) log.warn("abandoned capture runs closed", { closed });
  const alerts = evaluateAlerts(await enrichmentOpsSnapshot(db, undefined, now));
  const firing = new Set(alerts.map((alert) => alert.name));
  for (const alert of alerts) {
    const previous = lastLogged.get(alert.name);
    if (previous !== undefined && now.getTime() - previous < REPEAT_MS) continue;
    lastLogged.set(alert.name, now.getTime());
    log.error("enrichment alert firing", undefined, { alert: alert.name, severity: alert.severity, value: alert.value, threshold: alert.threshold, detail: alert.message, action: alert.action });
  }
  for (const name of [...lastLogged.keys()]) {
    if (firing.has(name)) continue;
    lastLogged.delete(name);
    log.info("enrichment alert resolved", { alert: name });
  }
  return alerts;
}

/** ENR-06 — evaluates enrichment alerts every five minutes; with or without Redis. */
export async function startEnrichmentOpsWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — enrichment ops worker disabled");
    return async () => {};
  }
  const { db, sql } = createDb(config.DATABASE_URL);
  const pass = () => withSpan("enrichment-ops.pass", () => runEnrichmentOpsPass(db)).catch((err) => log.error("enrichment ops pass failed", err));

  if (!(await isRedisAvailable(config))) {
    const timer = setInterval(pass, EVERY_MS);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await sql.end();
    };
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.upsertJobScheduler("enrichment-ops", { every: EVERY_MS }, { name: "enrichment-ops", data: {}, opts: { removeOnComplete: true, removeOnFail: 10 } });
  const worker = new Worker(QUEUE_NAME, async () => void (await pass()), { connection });
  worker.on("failed", (_job, err) => log.error("enrichment ops job failed", err));
  return async () => {
    await worker.close();
    await queue.close();
    await sql.end();
  };
}
