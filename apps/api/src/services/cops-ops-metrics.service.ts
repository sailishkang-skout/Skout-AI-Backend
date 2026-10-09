import { sql } from "drizzle-orm";
import type { Db } from "@skout/db";

/**
 * COPS-07 operational metrics for dashboards and alerts (Bible p.89): outbox lag, dead-lettered
 * events, provisioning latency against the 2-minute target, payment webhook latency and outcomes,
 * and follow-up steps stuck in `executing`. Scoped to one workspace for the admin page, or
 * platform-wide (workspaceId null) for the scheduled report that monitors read. Thresholds match
 * docs/runbooks/cops-platform.md and docs/ops/cops-alerts.md.
 */
export type MetricStatus = "ok" | "warn" | "critical";

export interface OpsMetric {
  key: string;
  label: string;
  value: number | null;
  unit: "seconds" | "count" | "ms" | "percent";
  warn_at: number | null;
  critical_at: number | null;
  status: MetricStatus;
  runbook: string;
}

export const PROVISIONING_TARGET_MS = 120_000;
export const STUCK_STEP_MINUTES = 15;

/** Higher is worse unless `lowerIsWorse`. A null value (nothing to measure) is ok. */
export function metricStatus(value: number | null, warnAt: number | null, criticalAt: number | null, lowerIsWorse = false): MetricStatus {
  if (value == null) return "ok";
  const beyond = (limit: number | null) => limit != null && (lowerIsWorse ? value < limit : value >= limit);
  return beyond(criticalAt) ? "critical" : beyond(warnAt) ? "warn" : "ok";
}

function metric(key: string, label: string, value: number | null, unit: OpsMetric["unit"], warnAt: number | null, criticalAt: number | null, runbook: string, lowerIsWorse = false): OpsMetric {
  return { key, label, value, unit, warn_at: warnAt, critical_at: criticalAt, status: metricStatus(value, warnAt, criticalAt, lowerIsWorse), runbook };
}

const one = async <T>(db: Db, query: ReturnType<typeof sql>) => ((await db.execute(query)) as unknown as T[])[0] as T;

export async function loadOpsMetrics(db: Db, workspaceId: string | null): Promise<{ generated_at: string; metrics: OpsMetric[] }> {
  /** One tenant, or every tenant for the platform-wide report. */
  const scope = (column: string) => (workspaceId ? sql`${sql.raw(column)} = ${workspaceId}` : sql`true`);

  const outbox = await one<{ pending: number; oldest_seconds: number | null; dead: number }>(
    db,
    sql`select
          count(*) filter (where published_at is null and dead_lettered_at is null)::int as pending,
          extract(epoch from now() - min(created_at) filter (where published_at is null and dead_lettered_at is null))::int as oldest_seconds,
          count(*) filter (where dead_lettered_at is not null)::int as dead
        from cops_outbox where ${scope("tenant_id")}`
  );
  const prov = await one<{ total: number; failed: number; p50: number | null; p95: number | null; within: number | null }>(
    db,
    sql`select
          count(*)::int as total,
          count(*) filter (where status = 'failed')::int as failed,
          (percentile_cont(0.5) within group (order by duration_ms) filter (where duration_ms is not null))::int as p50,
          (percentile_cont(0.95) within group (order by duration_ms) filter (where duration_ms is not null))::int as p95,
          (100.0 * count(*) filter (where duration_ms <= ${PROVISIONING_TARGET_MS}) / nullif(count(*) filter (where duration_ms is not null), 0))::int as within
        from cops_provisionings where ${scope("workspace_id")} and created_at > now() - interval '30 days'`
  );
  // Latency is provider send time to our receipt; processing is receipt to the applied outcome.
  // Unmatched events have no workspace, so they only count in the platform-wide report.
  const webhooks = await one<{ total: number; rejected: number; latency_p95: number | null; processing_p95: number | null }>(
    db,
    sql`select
          count(*)::int as total,
          count(*) filter (where outcome in ('unmatched', 'received'))::int as rejected,
          (percentile_cont(0.95) within group (order by greatest(0, extract(epoch from received_at - provider_created_at)))
             filter (where provider_created_at is not null))::int as latency_p95,
          (percentile_cont(0.95) within group (order by extract(epoch from processed_at - received_at) * 1000)
             filter (where processed_at is not null))::int as processing_p95
        from payment_provider_events where ${scope("workspace_id")} and received_at > now() - interval '24 hours'`
  );
  const steps = await one<{ stuck: number; failed: number }>(
    db,
    sql`select
          count(*) filter (where s.status = 'executing' and coalesce(s.executed_at, s.scheduled_at) < now() - make_interval(mins => ${STUCK_STEP_MINUTES}))::int as stuck,
          count(*) filter (where s.status = 'failed' and coalesce(s.executed_at, s.scheduled_at) > now() - interval '24 hours')::int as failed
        from sequence_enrollment_steps s
        join sequence_enrollments e on e.id = s.enrollment_id
        where ${scope("e.workspace_id")}`
  );

  const platform = "docs/runbooks/cops-platform.md";
  const commercial = "docs/runbooks/cops-commercial-credits.md";
  const onboarding = "docs/runbooks/cops-onboarding.md#a-step-is-stuck-in-executing";
  return {
    generated_at: new Date().toISOString(),
    metrics: [
      metric("outbox_lag_seconds", "Outbox lag (oldest unpublished event)", outbox.oldest_seconds, "seconds", 60, 300, `${platform}#1-outbox-lag-or-stuck-relay`),
      metric("outbox_pending", "Events waiting to publish", outbox.pending, "count", 500, 5000, `${platform}#1-outbox-lag-or-stuck-relay`),
      metric("outbox_dead_lettered", "Dead-lettered events", outbox.dead, "count", 1, 10, `${platform}#2-replay-dead-lettered-events`),
      metric("provisioning_p95_ms", "Provisioning latency p95 (30 days)", prov.p95, "ms", PROVISIONING_TARGET_MS, PROVISIONING_TARGET_MS * 2, `${commercial}#provisioning-is-slow-or-failed`),
      metric("provisioning_within_target_pct", "Provisionings within 2 minutes (30 days)", prov.within, "percent", 95, 80, `${commercial}#provisioning-is-slow-or-failed`, true),
      metric("provisioning_failed", "Failed provisionings (30 days)", prov.failed, "count", 1, 5, `${commercial}#provisioning-is-slow-or-failed`),
      metric("payment_webhooks_24h", "Payment webhooks received (24 hours)", webhooks.total, "count", null, null, `${commercial}#reconcile-a-payment`),
      metric("payment_webhooks_rejected_24h", "Payment webhooks not applied (24 hours)", webhooks.rejected, "count", 1, 10, `${commercial}#reconcile-a-payment`),
      metric("payment_webhook_latency_p95_seconds", "Payment webhook latency p95, provider to receipt (24 hours)", webhooks.latency_p95, "seconds", 60, 300, `${commercial}#reconcile-a-payment`),
      metric("payment_webhook_processing_p95_ms", "Payment webhook processing p95 (24 hours)", webhooks.processing_p95, "ms", 2000, 10_000, `${commercial}#reconcile-a-payment`),
      metric("workflow_steps_stuck", `Follow-up steps executing for over ${STUCK_STEP_MINUTES} minutes`, steps.stuck, "count", 1, 10, onboarding),
      metric("workflow_steps_failed_24h", "Follow-up steps failed (24 hours)", steps.failed, "count", 5, 25, onboarding),
    ],
  };
}

interface MetricLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Writes the platform-wide metrics as one structured log line each, at info / warn / error by
 * status. Log-based monitors alert on these lines (docs/ops/cops-monitors.json), so alerting needs
 * no metrics agent. Returns the metrics that are not ok.
 */
export async function reportPlatformOpsMetrics(db: Db, log: MetricLogger): Promise<OpsMetric[]> {
  const { metrics } = await loadOpsMetrics(db, null);
  for (const m of metrics) {
    const fields = { cops_metric: m.key, value: m.value, unit: m.unit, metric_status: m.status, warn_at: m.warn_at, critical_at: m.critical_at, runbook: m.runbook };
    if (m.status === "critical") log.error("cops ops metric critical", fields);
    else if (m.status === "warn") log.warn("cops ops metric warning", fields);
    else log.info("cops ops metric", fields);
  }
  return metrics.filter((m) => m.status !== "ok");
}
