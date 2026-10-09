import { sql } from "drizzle-orm";
import type { Db } from "@skout/db";

/**
 * COPS-07 operational metrics for dashboards and alerts (Bible p.89): outbox lag, dead-lettered
 * events, provisioning latency against the 2-minute target, payment webhook volume and outcomes,
 * and follow-up steps stuck in `executing`. Scoped to the caller's workspace. Thresholds match
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

export async function loadOpsMetrics(db: Db, workspaceId: string): Promise<{ generated_at: string; metrics: OpsMetric[] }> {
  const outbox = await one<{ pending: number; oldest_seconds: number | null; dead: number }>(
    db,
    sql`select
          count(*) filter (where published_at is null and dead_lettered_at is null)::int as pending,
          extract(epoch from now() - min(created_at) filter (where published_at is null and dead_lettered_at is null))::int as oldest_seconds,
          count(*) filter (where dead_lettered_at is not null)::int as dead
        from cops_outbox where tenant_id = ${workspaceId}`
  );
  const prov = await one<{ total: number; failed: number; p50: number | null; p95: number | null; within: number | null }>(
    db,
    sql`select
          count(*)::int as total,
          count(*) filter (where status = 'failed')::int as failed,
          (percentile_cont(0.5) within group (order by duration_ms) filter (where duration_ms is not null))::int as p50,
          (percentile_cont(0.95) within group (order by duration_ms) filter (where duration_ms is not null))::int as p95,
          (100.0 * count(*) filter (where duration_ms <= ${PROVISIONING_TARGET_MS}) / nullif(count(*) filter (where duration_ms is not null), 0))::int as within
        from cops_provisionings where workspace_id = ${workspaceId} and created_at > now() - interval '30 days'`
  );
  const webhooks = await one<{ total: number; rejected: number }>(
    db,
    sql`select count(*)::int as total, count(*) filter (where outcome in ('unmatched', 'received'))::int as rejected
        from payment_provider_events where workspace_id = ${workspaceId} and received_at > now() - interval '24 hours'`
  );
  const steps = await one<{ stuck: number; failed: number }>(
    db,
    sql`select
          count(*) filter (where s.status = 'executing' and coalesce(s.executed_at, s.scheduled_at) < now() - make_interval(mins => ${STUCK_STEP_MINUTES}))::int as stuck,
          count(*) filter (where s.status = 'failed' and coalesce(s.executed_at, s.scheduled_at) > now() - interval '24 hours')::int as failed
        from sequence_enrollment_steps s
        join sequence_enrollments e on e.id = s.enrollment_id
        where e.workspace_id = ${workspaceId}`
  );

  return {
    generated_at: new Date().toISOString(),
    metrics: [
      metric("outbox_lag_seconds", "Outbox lag (oldest unpublished event)", outbox.oldest_seconds, "seconds", 60, 300, "docs/runbooks/cops-platform.md#1-outbox-lag-or-stuck-relay"),
      metric("outbox_pending", "Events waiting to publish", outbox.pending, "count", 500, 5000, "docs/runbooks/cops-platform.md#1-outbox-lag-or-stuck-relay"),
      metric("outbox_dead_lettered", "Dead-lettered events", outbox.dead, "count", 1, 10, "docs/runbooks/cops-platform.md#2-replay-dead-lettered-events"),
      metric("provisioning_p95_ms", "Provisioning latency p95 (30 days)", prov.p95, "ms", PROVISIONING_TARGET_MS, PROVISIONING_TARGET_MS * 2, "docs/runbooks/cops-commercial-credits.md#provisioning-is-slow-or-failed"),
      metric("provisioning_within_target_pct", "Provisionings within 2 minutes (30 days)", prov.within, "percent", 95, 80, "docs/runbooks/cops-commercial-credits.md#provisioning-is-slow-or-failed", true),
      metric("provisioning_failed", "Failed provisionings (30 days)", prov.failed, "count", 1, 5, "docs/runbooks/cops-commercial-credits.md#provisioning-is-slow-or-failed"),
      metric("payment_webhooks_24h", "Payment webhooks received (24 hours)", webhooks.total, "count", null, null, "docs/runbooks/cops-commercial-credits.md#reconcile-a-payment"),
      metric("payment_webhooks_rejected_24h", "Payment webhooks not applied (24 hours)", webhooks.rejected, "count", 1, 10, "docs/runbooks/cops-commercial-credits.md#reconcile-a-payment"),
      metric("workflow_steps_stuck", `Follow-up steps executing for over ${STUCK_STEP_MINUTES} minutes`, steps.stuck, "count", 1, 10, "docs/runbooks/cops-onboarding.md#a-step-is-stuck-in-executing"),
      metric("workflow_steps_failed_24h", "Follow-up steps failed (24 hours)", steps.failed, "count", 5, 25, "docs/runbooks/cops-onboarding.md#a-step-is-stuck-in-executing"),
    ],
  };
}
