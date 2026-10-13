import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { saveConfig } from "./cops-admin-config.service.js";
import { loadCopsModules } from "./cops-feature-flags.js";
import { classifyTable, listRetentionRuns, loadDataInventory, RETENTION_TARGETS, startRetentionRun } from "./cops-retention.service.js";
import { loadOpsMetrics, metricStatus, reportPlatformOpsMetrics, submitOpsMetricsToDatadog, toDatadogSeries, type OpsMetric } from "./cops-ops-metrics.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

describe("COPS-07 pure rules", () => {
  it("classifies tables into Appendix F categories", () => {
    expect(classifyTable("audit_logs")).toBe("audit_logs");
    expect(classifyTable("cops_onboarding_email_sends")).toBe("communications");
    expect(classifyTable("ticket_comments")).toBe("communications");
    expect(classifyTable("cops_outbox")).toBe("diagnostics");
    expect(classifyTable("ai_drafts")).toBe("ai_traces");
    expect(classifyTable("companies")).toBe("core_records");
  });

  it("grades a metric against its thresholds, in either direction", () => {
    expect(metricStatus(30, 60, 300)).toBe("ok");
    expect(metricStatus(60, 60, 300)).toBe("warn");
    expect(metricStatus(900, 60, 300)).toBe("critical");
    expect(metricStatus(null, 60, 300)).toBe("ok");
    // Share within target: lower is worse.
    expect(metricStatus(97, 95, 80, true)).toBe("ok");
    expect(metricStatus(90, 95, 80, true)).toBe("warn");
    expect(metricStatus(60, 95, 80, true)).toBe("critical");
  });

  const sample: OpsMetric[] = [
    { key: "outbox_lag_seconds", label: "Outbox lag", value: 900, unit: "seconds", warn_at: 60, critical_at: 300, status: "critical", runbook: "docs/runbooks/cops-platform.md" },
    { key: "outbox_pending", label: "Pending", value: 0, unit: "count", warn_at: 500, critical_at: 5000, status: "ok", runbook: "docs/runbooks/cops-platform.md" },
    { key: "provisioning_p95_ms", label: "p95", value: null, unit: "ms", warn_at: 120000, critical_at: 240000, status: "ok", runbook: "docs/runbooks/cops-commercial-credits.md" },
  ];

  it("turns a report into Datadog gauges: a heartbeat, a value per measured metric and a status per metric", () => {
    const at = new Date("2026-10-13T10:00:00Z");
    const series = toDatadogSeries(sample, "production", at);
    const by = (metric: string) => series.filter((s) => s.metric === metric);
    expect(by("skout.cops.report")).toHaveLength(1);
    expect(by("skout.cops.outbox_lag_seconds")[0]!.points).toEqual([{ timestamp: 1791885600, value: 900 }]);
    // Nothing to measure: no value point, but the status is still reported.
    expect(by("skout.cops.provisioning_p95_ms")).toHaveLength(0);
    const status = Object.fromEntries(by("skout.cops.metric_status").map((s) => [s.tags.find((t) => t.startsWith("metric:")), s.points[0]!.value]));
    expect(status).toEqual({ "metric:outbox_lag_seconds": 2, "metric:outbox_pending": 0, "metric:provisioning_p95_ms": 0 });
    expect(series.every((s) => s.type === 3 && s.tags.includes("env:production") && s.tags.includes("service:skout-api"))).toBe(true);
  });

  it("submits the gauges with the API key, and reports a refusal or a missing key as not sent", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    expect(await submitOpsMetricsToDatadog(sample, { apiKey: "k", site: "us5.datadoghq.com", env: "uat", fetchImpl: ok })).toBe(true);
    expect(calls[0]!.url).toBe("https://api.us5.datadoghq.com/api/v2/series");
    expect((calls[0]!.init.headers as Record<string, string>)["DD-API-KEY"]).toBe("k");
    expect(JSON.parse(String(calls[0]!.init.body)).series.length).toBe(6);
    const refused = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    expect(await submitOpsMetricsToDatadog(sample, { apiKey: "k", site: "us5.datadoghq.com", env: "uat", fetchImpl: refused })).toBe(false);
    expect(await submitOpsMetricsToDatadog(sample, { apiKey: undefined, site: "us5.datadoghq.com", env: "uat", fetchImpl: ok })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("every retention target is a table the classifier puts in the same category", () => {
    for (const t of RETENTION_TARGETS) expect(classifyTable(t.table), t.table).toBe(t.category);
  });
});

/**
 * COPS-07 retention, feature flags and ops metrics against a real Postgres. Retention: nothing is
 * deleted by default, a dry run deletes nothing, apply needs a recent dry run of the same policy
 * and a reason, and only this workspace's old rows go.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-07 retention, flags and metrics (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ctx: { workspaceId: string; userId: string; requestId: string };
  let other: string;

  const key = (ws: string, daysOld: number, state = "completed") =>
    sql`insert into cops_idempotency_keys (workspace_id, key, request_hash, state, expires_at, created_at)
        values (${ws}, ${"ret-" + randomUUID()}, 'h', ${state}, now() + interval '1 day', now() - make_interval(days => ${daysOld}))`;
  const keys = async (ws: string) => (await sql`select count(*)::int as n from cops_idempotency_keys where workspace_id = ${ws}`)[0].n as number;
  const policy = (diagnosticsDays: number | null) => ({ categories: { diagnostics: { days: diagnosticsDays }, audit_logs: { days: null } } });

  beforeAll(async () => {
    const [ws] = await sql`insert into workspaces (name, slug) values ('Retention ops', ${"ret-" + randomUUID()}) returning id`;
    const [ws2] = await sql`insert into workspaces (name, slug) values ('Retention other', ${"ret2-" + randomUUID()}) returning id`;
    const [user] = await sql`insert into users (email) values (${`admin-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    ctx = { workspaceId: ws.id, userId: user.id, requestId: randomUUID() };
    other = ws2.id;
    await key(ctx.workspaceId, 90);
    await key(ctx.workspaceId, 90, "pending");
    await key(ctx.workspaceId, 5);
    await key(other, 90);
  });

  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  it("the default policy keeps everything: a run has no targets and removes nothing", async () => {
    const run = await startRetentionRun(db, ctx, { mode: "dry_run" });
    expect(run).toMatchObject({ mode: "dry_run", policy_version: 0, counts: {}, total_rows: 0 });
    expect(await keys(ctx.workspaceId)).toBe(3);
  });

  it("a dry run counts what would go and deletes nothing", async () => {
    await saveConfig(db, ctx, "retention_policy", "default", { value: policy(30), reason: "Keep diagnostics for 30 days" });
    const dry = await startRetentionRun(db, ctx, { mode: "dry_run" });
    // The old completed key counts; the old pending key and the recent key do not.
    expect(dry.counts.cops_idempotency_keys).toMatchObject({ category: "diagnostics", days: 30, rows: 1 });
    expect(await keys(ctx.workspaceId)).toBe(3);
  });

  it("apply is refused without a dry run, without a reason, or after the policy changed", async () => {
    await expect(startRetentionRun(db, ctx, { mode: "apply", reason: "cleanup" })).rejects.toMatchObject({ code: "BUSINESS_STATE_CONFLICT", status: 409 });
    const dry = await startRetentionRun(db, ctx, { mode: "dry_run" });
    await expect(startRetentionRun(db, ctx, { mode: "apply", dry_run_id: dry.id })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(startRetentionRun(db, { ...ctx, workspaceId: other }, { mode: "apply", dry_run_id: dry.id, reason: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const late = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await expect(startRetentionRun(db, ctx, { mode: "apply", dry_run_id: dry.id, reason: "x" }, late)).rejects.toMatchObject({ code: "BUSINESS_STATE_CONFLICT" });
    await saveConfig(db, ctx, "retention_policy", "default", { value: policy(60), reason: "Keep longer" });
    await expect(startRetentionRun(db, ctx, { mode: "apply", dry_run_id: dry.id, reason: "x" })).rejects.toMatchObject({
      code: "BUSINESS_STATE_CONFLICT",
      details: { policy_version: 2 },
    });
    expect(await keys(ctx.workspaceId)).toBe(3);
  });

  it("apply after a matching dry run deletes only this workspace's old rows, and is audited", async () => {
    const dry = await startRetentionRun(db, ctx, { mode: "dry_run" });
    const applied = await startRetentionRun(db, ctx, { mode: "apply", dry_run_id: dry.id, reason: "Quarterly cleanup" });
    expect(applied).toMatchObject({ mode: "apply", dry_run_id: dry.id, reason: "Quarterly cleanup" });
    expect(applied.counts.cops_idempotency_keys.rows).toBe(1);
    expect(await keys(ctx.workspaceId)).toBe(2);
    expect(await keys(other)).toBe(1);
    const [audit] = await sql`select reason, is_override from audit_logs where entity_id = ${applied.id} and action = 'retention.applied'`;
    expect(audit).toMatchObject({ reason: "Quarterly cleanup", is_override: true });
    expect((await listRetentionRuns(db, ctx.workspaceId))[0].id).toBe(applied.id);
    expect(await listRetentionRuns(db, other)).toEqual([]);
  });

  it("the data inventory covers the live schema with categories and tags", async () => {
    const inventory = await loadDataInventory(db);
    expect(inventory.length).toBeGreaterThan(100);
    expect(inventory.find((r) => r.table === "contacts")).toMatchObject({ category: "core_records", retention: "dsar_only" });
    expect(inventory.find((r) => r.table === "contacts")!.tags).toEqual(expect.arrayContaining(["tenant_scoped", "personal_data"]));
    expect(inventory.find((r) => r.table === "audit_logs")).toMatchObject({ category: "audit_logs", retention: "automatic" });
    expect(inventory.find((r) => r.table === "user_credentials")!.tags).toContain("credentials");
  });

  it("modules are on by default; an admin can turn one off but never the admin module", async () => {
    expect(await loadCopsModules(db, ctx.workspaceId)).toMatchObject({ tickets: true, onboarding: true, admin: true });
    await saveConfig(db, ctx, "feature_flags", "default", { value: { modules: { tickets: false, admin: false } }, reason: "Tickets pilot paused" });
    expect(await loadCopsModules(db, ctx.workspaceId)).toMatchObject({ tickets: false, onboarding: true, admin: true });
    expect((await loadCopsModules(db, other)).tickets).toBe(true);
  });

  it("ops metrics report each health number with its thresholds and runbook", async () => {
    await sql`insert into cops_outbox (id, tenant_id, event_type, aggregate_type, aggregate_id, envelope, created_at, dead_lettered_at)
              values (gen_random_uuid(), ${ctx.workspaceId}, 'TicketCreated', 'ticket', gen_random_uuid(), '{}'::jsonb, now() - interval '2 hours', now())`;
    await sql`insert into cops_outbox (id, tenant_id, event_type, aggregate_type, aggregate_id, envelope, created_at)
              values (gen_random_uuid(), ${ctx.workspaceId}, 'TicketCreated', 'ticket', gen_random_uuid(), '{}'::jsonb, now() - interval '10 minutes')`;
    const { metrics } = await loadOpsMetrics(db, ctx.workspaceId);
    const by = Object.fromEntries(metrics.map((m) => [m.key, m]));
    expect(by.outbox_dead_lettered).toMatchObject({ value: 1, status: "warn" });
    expect(by.outbox_pending!.value).toBe(1);
    expect(by.outbox_lag_seconds!.value).toBeGreaterThanOrEqual(590);
    expect(by.outbox_lag_seconds!.status).toBe("critical");
    expect(by.provisioning_p95_ms).toMatchObject({ value: null, status: "ok" });
    expect(metrics.every((m) => m.runbook.startsWith("docs/runbooks/"))).toBe(true);
    // Payment webhook latency: provider send time to receipt, and receipt to outcome.
    for (const [late, ms] of [[4, 150], [8, 300], [400, 900]] as const) {
      await sql`insert into payment_provider_events (workspace_id, provider, provider_event_id, event_type, outcome, provider_created_at, received_at, processed_at)
                values (${ctx.workspaceId}, 'razorpay', ${"evt-" + randomUUID()}, 'payment_link.paid', 'applied',
                        now() - make_interval(secs => ${late + 60}), now() - interval '60 seconds', now() - interval '60 seconds' + make_interval(secs => ${ms / 1000}))`;
    }
    const withWebhooks = Object.fromEntries((await loadOpsMetrics(db, ctx.workspaceId)).metrics.map((m) => [m.key, m]));
    expect(withWebhooks.payment_webhooks_24h!.value).toBe(3);
    expect(withWebhooks.payment_webhook_latency_p95_seconds!.value).toBeGreaterThan(300);
    expect(withWebhooks.payment_webhook_latency_p95_seconds!.status).toBe("critical");
    expect(withWebhooks.payment_webhook_processing_p95_ms!.value).toBeGreaterThan(300);
    expect(withWebhooks.payment_webhook_processing_p95_ms!.status).toBe("ok");

    // The scheduled report covers every workspace and logs each metric at the level of its status.
    const lines: Array<{ level: string; fields: Record<string, unknown> }> = [];
    const logger = {
      info: (_m: string, fields?: Record<string, unknown>) => lines.push({ level: "info", fields: fields ?? {} }),
      warn: (_m: string, fields?: Record<string, unknown>) => lines.push({ level: "warn", fields: fields ?? {} }),
      error: (_m: string, fields?: Record<string, unknown>) => lines.push({ level: "error", fields: fields ?? {} }),
    };
    // Datadog being down must not fail the report; it is logged as one extra warning.
    const down = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const notOk = await reportPlatformOpsMetrics(db, logger, { apiKey: "k", site: "us5.datadoghq.com", env: "test", fetchImpl: down });
    expect(lines.filter((l) => l.fields.cops_metric)).toHaveLength(12);
    expect(lines.filter((l) => !l.fields.cops_metric)).toEqual([{ level: "warn", fields: { site: "us5.datadoghq.com" } }]);
    expect(notOk.map((m) => m.key)).toContain("outbox_dead_lettered");
    const dead = lines.find((l) => l.fields.cops_metric === "outbox_dead_lettered")!;
    expect(["warn", "error"]).toContain(dead.level);
    expect(dead.fields.runbook).toContain("docs/runbooks/");

    // Another workspace sees none of it.
    const quiet = Object.fromEntries((await loadOpsMetrics(db, other)).metrics.map((m) => [m.key, m.value]));
    expect(quiet).toMatchObject({ outbox_dead_lettered: 0, outbox_pending: 0 });
  });
});
