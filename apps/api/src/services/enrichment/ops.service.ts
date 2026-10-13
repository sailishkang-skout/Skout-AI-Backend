import { and, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { PROVIDER_JOB_KIND } from "./provider-jobs.service.js";

/**
 * ENR-06 — bounded observability for LinkedIn enrichment.
 *
 * One snapshot answers "is the pipeline healthy": capture runs, provider jobs, provider errors
 * and queue lag, each over a fixed window and with a fixed set of labels (status and error
 * code — never a workspace id, a URL or a person). The snapshot is read from the database, so
 * it is the same from every API instance and survives a restart.
 *
 * `evaluateAlerts` turns a snapshot into named alerts with thresholds. The alert worker logs
 * them at error level and the same numbers are exported on /metrics, so a monitor can be built
 * on either. A background failure therefore always shows up somewhere a person looks.
 */

const { enrichmentCaptureRuns, enrichmentCampaigns, enrichmentJobs } = schema;

export const OPS_WINDOW_HOURS = 24;
const WINDOW_MS = OPS_WINDOW_HOURS * 60 * 60 * 1000;
/** A capture run the browser never finished. Matches capture-ingest's own cut-off. */
const CAPTURE_ABANDONED_MS = 2 * 60 * 60 * 1000;

export const CAPTURE_RUN_STATUSES = ["running", "completed", "stopped", "failed", "halted", "rejected"] as const;
export const JOB_STATUSES = ["queued", "running", "partial", "action_required", "failed", "completed"] as const;

export interface OpsSnapshot {
  windowHours: number;
  generatedAt: string;
  captureRuns: {
    byStatus: Record<(typeof CAPTURE_RUN_STATUSES)[number], number>;
    /** Still "running" long after any browser would have finished. */
    abandoned: number;
    leadsReceived: number;
    leadsRejected: number;
  };
  jobs: {
    byStatus: Record<(typeof JOB_STATUSES)[number], number>;
    /** Terminal failures in the window by error code. */
    errorsByCode: Record<string, number>;
    /** Running jobs whose worker lease has run out: nobody is running them. */
    lostLeases: number;
  };
  queue: {
    /** Jobs waiting for a worker right now (due, not scheduled for later). */
    waiting: number;
    /** Age in seconds of the oldest job that is due and still waiting. 0 when none. */
    lagSeconds: number;
  };
  campaigns: { pendingReview: number; changesRequired: number };
}

const zero = <T extends string>(keys: readonly T[]) => Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;

/** A snapshot for one workspace, or for the whole platform when no workspace is given. */
export async function enrichmentOpsSnapshot(db: Db, workspaceId?: string, now = new Date()): Promise<OpsSnapshot> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const runScope = workspaceId ? eq(enrichmentCaptureRuns.workspaceId, workspaceId) : undefined;
  const jobScope = and(eq(enrichmentJobs.kind, PROVIDER_JOB_KIND), workspaceId ? eq(enrichmentJobs.workspaceId, workspaceId) : undefined);
  const due = or(isNull(enrichmentJobs.nextAttemptAt), lte(enrichmentJobs.nextAttemptAt, now));

  const [runs, [abandoned], jobs, errors, [lost], [queue], campaigns] = await Promise.all([
    db
      .select({
        status: enrichmentCaptureRuns.status,
        count: sql<number>`count(*)::int`,
        received: sql<number>`coalesce(sum(${enrichmentCaptureRuns.leadsReceived}), 0)::int`,
        rejected: sql<number>`coalesce(sum(${enrichmentCaptureRuns.leadsRejected}), 0)::int`,
      })
      .from(enrichmentCaptureRuns)
      .where(and(runScope, gte(enrichmentCaptureRuns.startedAt, since)))
      .groupBy(enrichmentCaptureRuns.status),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(enrichmentCaptureRuns)
      .where(and(runScope, eq(enrichmentCaptureRuns.status, "running"), lt(enrichmentCaptureRuns.updatedAt, new Date(now.getTime() - CAPTURE_ABANDONED_MS)))),
    db
      .select({ status: enrichmentJobs.status, count: sql<number>`count(*)::int` })
      .from(enrichmentJobs)
      .where(and(jobScope, gte(enrichmentJobs.queuedAt, since)))
      .groupBy(enrichmentJobs.status),
    db
      .select({ code: enrichmentJobs.errorCode, count: sql<number>`count(*)::int` })
      .from(enrichmentJobs)
      .where(and(jobScope, gte(enrichmentJobs.queuedAt, since), inArray(enrichmentJobs.status, ["failed", "action_required"])))
      .groupBy(enrichmentJobs.errorCode),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(enrichmentJobs)
      .where(and(jobScope, eq(enrichmentJobs.status, "running"), lt(enrichmentJobs.leaseExpiresAt, now))),
    db
      .select({
        waiting: sql<number>`count(*)::int`,
        // A retried job has been waiting since it became due, not since it was first queued.
        oldest: sql<string | null>`min(coalesce(${enrichmentJobs.nextAttemptAt}, ${enrichmentJobs.queuedAt}))`,
      })
      .from(enrichmentJobs)
      .where(and(jobScope, eq(enrichmentJobs.status, "queued"), due)),
    db
      .select({ status: enrichmentCampaigns.status, count: sql<number>`count(*)::int` })
      .from(enrichmentCampaigns)
      .where(and(workspaceId ? eq(enrichmentCampaigns.workspaceId, workspaceId) : undefined, inArray(enrichmentCampaigns.status, ["pending_review", "changes_required"])))
      .groupBy(enrichmentCampaigns.status),
  ]);

  const runsByStatus = zero(CAPTURE_RUN_STATUSES);
  let leadsReceived = 0;
  let leadsRejected = 0;
  for (const row of runs) {
    if (row.status in runsByStatus) runsByStatus[row.status as keyof typeof runsByStatus] = row.count;
    leadsReceived += row.received;
    leadsRejected += row.rejected;
  }
  const jobsByStatus = zero(JOB_STATUSES);
  for (const row of jobs) if (row.status in jobsByStatus) jobsByStatus[row.status as keyof typeof jobsByStatus] = row.count;
  const oldest = queue?.oldest ? new Date(queue.oldest).getTime() : null;
  const campaignCount = (status: string) => campaigns.find((row) => row.status === status)?.count ?? 0;

  return {
    windowHours: OPS_WINDOW_HOURS,
    generatedAt: now.toISOString(),
    captureRuns: { byStatus: runsByStatus, abandoned: abandoned?.count ?? 0, leadsReceived, leadsRejected },
    jobs: {
      byStatus: jobsByStatus,
      errorsByCode: Object.fromEntries(errors.map((row) => [row.code ?? "UNKNOWN", row.count])),
      lostLeases: lost?.count ?? 0,
    },
    queue: { waiting: queue?.waiting ?? 0, lagSeconds: oldest === null ? 0 : Math.max(0, Math.round((now.getTime() - oldest) / 1000)) },
    campaigns: { pendingReview: campaignCount("pending_review"), changesRequired: campaignCount("changes_required") },
  };
}

// ── Alerts ───────────────────────────────────────────────────────────────────

export const ALERT_THRESHOLDS = {
  /** A due job should be picked up within seconds; the recovery pass runs every 30. */
  queueLagSeconds: 300,
  /** Share of finished jobs that failed, once enough have finished to mean something. */
  jobFailureRate: 0.25,
  captureFailureRate: 0.3,
  minimumSample: 10,
} as const;

export type AlertSeverity = "page" | "ticket";

export interface OpsAlert {
  name: string;
  severity: AlertSeverity;
  /** What is wrong, with the number that tripped it. */
  message: string;
  /** What to do first. */
  action: string;
  value: number;
  threshold: number;
}

export function evaluateAlerts(snapshot: OpsSnapshot): OpsAlert[] {
  const alerts: OpsAlert[] = [];
  const { jobs, queue, captureRuns } = snapshot;
  const add = (alert: OpsAlert) => alerts.push(alert);

  if (queue.lagSeconds > ALERT_THRESHOLDS.queueLagSeconds) {
    add({
      name: "enrichment_queue_lag_high",
      severity: "page",
      message: `The oldest due enrichment job has waited ${queue.lagSeconds}s (${queue.waiting} waiting).`,
      action: "Check that the enrichment provider job worker and Redis are up; the worker's recovery pass re-queues due jobs every 30s.",
      value: queue.lagSeconds,
      threshold: ALERT_THRESHOLDS.queueLagSeconds,
    });
  }
  if (jobs.lostLeases > 0) {
    add({
      name: "enrichment_jobs_lost_lease",
      severity: "page",
      message: `${jobs.lostLeases} enrichment job(s) are marked running with an expired worker lease.`,
      action: "The recovery pass is not running. Restart the API/worker; on start-up it re-queues or fails these jobs.",
      value: jobs.lostLeases,
      threshold: 0,
    });
  }
  const workerLost = jobs.errorsByCode.WORKER_LOST ?? 0;
  if (workerLost > 0) {
    add({
      name: "enrichment_jobs_worker_lost",
      severity: "ticket",
      message: `${workerLost} enrichment job(s) failed in the last ${snapshot.windowHours}h because their worker stopped and no attempt was left.`,
      action: "Look for worker crashes or deploys that overlap long provider requests. Users can re-run the affected jobs.",
      value: workerLost,
      threshold: 0,
    });
  }
  const finished = jobs.byStatus.failed + jobs.byStatus.completed + jobs.byStatus.partial + jobs.byStatus.action_required;
  if (finished >= ALERT_THRESHOLDS.minimumSample && jobs.byStatus.failed / finished > ALERT_THRESHOLDS.jobFailureRate) {
    const rate = jobs.byStatus.failed / finished;
    add({
      name: "enrichment_job_failure_rate_high",
      severity: "ticket",
      message: `${Math.round(rate * 100)}% of enrichment jobs failed in the last ${snapshot.windowHours}h (${jobs.byStatus.failed} of ${finished}).`,
      action: "Read jobs.errorsByCode for the dominant error code: provider outage, rate limit or invalid responses.",
      value: Number(rate.toFixed(3)),
      threshold: ALERT_THRESHOLDS.jobFailureRate,
    });
  }
  const credential = (jobs.errorsByCode.PROVIDER_CREDENTIAL_REJECTED ?? 0) + (jobs.errorsByCode.PROVIDER_CREDENTIAL_REQUIRED ?? 0);
  if (credential > 0) {
    add({
      name: "enrichment_provider_credential_errors",
      severity: "ticket",
      message: `${credential} enrichment job(s) stopped on a missing or rejected provider credential in the last ${snapshot.windowHours}h.`,
      action: "The affected workspaces need to update their provider key under Settings → Integrations. If it is the platform key, rotate it.",
      value: credential,
      threshold: 0,
    });
  }
  const rateLimited = jobs.errorsByCode.PROVIDER_RATE_LIMITED ?? 0;
  if (rateLimited > 0) {
    add({
      name: "enrichment_provider_rate_limited",
      severity: "ticket",
      message: `${rateLimited} enrichment job(s) gave up on provider rate limits in the last ${snapshot.windowHours}h.`,
      action: "Reduce the daily job limit (entitlement enrichment.provider_daily_job_limit) or the connected account's load. Do not add retries.",
      value: rateLimited,
      threshold: 0,
    });
  }
  if (captureRuns.abandoned > 0) {
    add({
      name: "enrichment_capture_runs_abandoned",
      severity: "ticket",
      message: `${captureRuns.abandoned} capture run(s) have been running for over two hours.`,
      action: "The ops worker closes these as failed/abandoned; if the count stays above zero the worker is not running.",
      value: captureRuns.abandoned,
      threshold: 0,
    });
  }
  const runsFinished = captureRuns.byStatus.completed + captureRuns.byStatus.stopped + captureRuns.byStatus.failed + captureRuns.byStatus.halted + captureRuns.byStatus.rejected;
  const runsBad = captureRuns.byStatus.failed + captureRuns.byStatus.rejected;
  if (runsFinished >= ALERT_THRESHOLDS.minimumSample && runsBad / runsFinished > ALERT_THRESHOLDS.captureFailureRate) {
    const rate = runsBad / runsFinished;
    add({
      name: "enrichment_capture_failure_rate_high",
      severity: "ticket",
      message: `${Math.round(rate * 100)}% of capture runs failed or were rejected in the last ${snapshot.windowHours}h (${runsBad} of ${runsFinished}).`,
      action: "LinkedIn's page markup may have changed: check the extension's parser fixtures. If LinkedIn is warning accounts, turn on the capture kill switch.",
      value: Number(rate.toFixed(3)),
      threshold: ALERT_THRESHOLDS.captureFailureRate,
    });
  }
  return alerts;
}

// ── Prometheus ───────────────────────────────────────────────────────────────

/** Platform-wide gauges for /metrics. Labels are statuses and error codes only. */
export function formatOpsPrometheus(snapshot: OpsSnapshot): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, samples: Array<[string, number]>) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`);
  };
  const label = (key: string, value: string) => `{${key}="${value.replace(/[^A-Za-z0-9_]/g, "_")}"}`;
  gauge("skout_enrichment_capture_runs", `Capture runs started in the last ${snapshot.windowHours}h by status`, Object.entries(snapshot.captureRuns.byStatus).map(([status, count]) => [label("status", status), count]));
  gauge("skout_enrichment_capture_runs_abandoned", "Capture runs still running after two hours", [["", snapshot.captureRuns.abandoned]]);
  gauge("skout_enrichment_capture_leads_received", `Leads received by capture runs in the last ${snapshot.windowHours}h`, [["", snapshot.captureRuns.leadsReceived]]);
  gauge("skout_enrichment_capture_leads_rejected", `Leads rejected by capture runs in the last ${snapshot.windowHours}h`, [["", snapshot.captureRuns.leadsRejected]]);
  gauge("skout_enrichment_jobs", `Provider jobs queued in the last ${snapshot.windowHours}h by status`, Object.entries(snapshot.jobs.byStatus).map(([status, count]) => [label("status", status), count]));
  gauge("skout_enrichment_job_errors", `Provider jobs stopped in the last ${snapshot.windowHours}h by error code`, Object.entries(snapshot.jobs.errorsByCode).map(([code, count]) => [label("code", code), count]));
  gauge("skout_enrichment_jobs_lost_lease", "Running provider jobs whose worker lease has expired", [["", snapshot.jobs.lostLeases]]);
  gauge("skout_enrichment_queue_waiting", "Provider jobs due and waiting for a worker", [["", snapshot.queue.waiting]]);
  gauge("skout_enrichment_queue_lag_seconds", "Age of the oldest due provider job still waiting", [["", snapshot.queue.lagSeconds]]);
  gauge("skout_enrichment_campaigns_pending_review", "Campaigns waiting for a reviewer", [["", snapshot.campaigns.pendingReview]]);
  gauge("skout_enrichment_campaigns_changes_required", "Campaigns whose approval was withdrawn", [["", snapshot.campaigns.changesRequired]]);
  return lines.join("\n");
}

let cached: { at: number; body: string } | null = null;
const CACHE_MS = 30_000;

/** /metrics body for enrichment. Cached briefly so a scrape never costs more than one snapshot per 30s. */
export async function enrichmentMetricsPrometheus(db: Db | null | undefined, now = Date.now()): Promise<string> {
  if (!db) return "";
  if (cached && now - cached.at < CACHE_MS) return cached.body;
  try {
    const body = `${formatOpsPrometheus(await enrichmentOpsSnapshot(db))}\n# HELP skout_enrichment_metrics_up 1 if enrichment metrics could be read\n# TYPE skout_enrichment_metrics_up gauge\nskout_enrichment_metrics_up 1`;
    cached = { at: now, body };
    return body;
  } catch {
    // The scrape must not fail because one section could not be read; say so instead.
    return "# HELP skout_enrichment_metrics_up 1 if enrichment metrics could be read\n# TYPE skout_enrichment_metrics_up gauge\nskout_enrichment_metrics_up 0";
  }
}

// ── Housekeeping ─────────────────────────────────────────────────────────────

/** Closes capture runs nobody finished, in every workspace, so none stays "running" forever. */
export async function closeAbandonedCaptureRuns(db: Db, now = new Date()): Promise<number> {
  const closed = await db
    .update(enrichmentCaptureRuns)
    .set({
      status: "failed",
      errorCode: "abandoned",
      errorMessage: "The capture was not finished. The browser tab was closed or the extension was reloaded.",
      completedAt: now,
      updatedAt: now,
    })
    .where(and(eq(enrichmentCaptureRuns.status, "running"), lt(enrichmentCaptureRuns.updatedAt, new Date(now.getTime() - CAPTURE_ABANDONED_MS))))
    .returning({ id: enrichmentCaptureRuns.id });
  return closed.length;
}
