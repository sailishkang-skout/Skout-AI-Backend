import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@skout/db";
import { and, eq, isNull, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildTestAuth, buildTestAuthEnv, grantSystemMemberRole } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import {
  ALERT_THRESHOLDS,
  closeAbandonedCaptureRuns,
  enrichmentMetricsPrometheus,
  enrichmentOpsSnapshot,
  evaluateAlerts,
  formatOpsPrometheus,
  type OpsSnapshot,
} from "../services/enrichment/ops.service.js";
import { runEnrichmentOpsPass } from "../workers/enrichment-ops.worker.js";

const WORKSPACE = randomUUID();
let app: FastifyInstance;
let owner: Record<string, string>;
let member: Record<string, string>;
const { enrichmentCaptureRuns, enrichmentJobs, enrichmentCampaigns } = schema;

async function provisionUser(role: "owner" | "member") {
  const db = app.db!;
  const userId = randomUUID();
  const email = `ops-test-${userId}@example.com`;
  await db.insert(schema.users).values({ id: userId, email, fullName: "Ops Test User", status: "active" });
  await db.insert(schema.workspaceMembers).values({ workspaceId: WORKSPACE, userId, role });
  if (!(await grantSystemMemberRole(db, WORKSPACE, userId, role))) throw new Error("System roles are not seeded");
  const auth = buildTestAuth({ workspaceId: WORKSPACE, userId, email, role });
  return { "x-workspace-id": WORKSPACE, "content-type": "application/json", Authorization: auth.bearer };
}

beforeAll(async () => {
  app = await buildApp({ ...loadEnv(), LOG_LEVEL: "fatal" as const, ...buildTestAuthEnv() });
  const db = app.db!;
  await db.insert(schema.workspaces).values({ id: WORKSPACE, name: "Ops test", slug: `ops-test-${WORKSPACE}` });
  const [ownerRole] = await db.select({ id: schema.roles.id }).from(schema.roles).where(and(eq(schema.roles.key, "owner"), isNull(schema.roles.workspaceId))).limit(1);
  const permissions = await db.select({ key: schema.permissions.key }).from(schema.permissions).where(like(schema.permissions.key, "enrichment:%"));
  for (const permission of permissions) await db.insert(schema.rolePermissions).values({ roleId: ownerRole!.id, permissionKey: permission.key }).onConflictDoNothing();
  owner = await provisionUser("owner");
  member = await provisionUser("member");
}, 60000);

afterAll(async () => {
  await app?.close();
});

const db = () => app.db!;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const job = (fields: Partial<typeof enrichmentJobs.$inferInsert>) =>
  db().insert(enrichmentJobs).values({ workspaceId: WORKSPACE, prospectId: `ops-${randomUUID()}`, kind: "linkedin_profile", status: "queued", ...fields });
const run = (fields: Partial<typeof enrichmentCaptureRuns.$inferInsert>) =>
  db().insert(enrichmentCaptureRuns).values({ workspaceId: WORKSPACE, kind: "sales_search", status: "completed", ...fields }).returning();

const healthy = (): OpsSnapshot => ({
  windowHours: 24,
  generatedAt: new Date().toISOString(),
  captureRuns: { byStatus: { running: 0, completed: 20, stopped: 1, failed: 0, halted: 0, rejected: 0 }, abandoned: 0, leadsReceived: 400, leadsRejected: 3 },
  jobs: { byStatus: { queued: 0, running: 1, partial: 12, action_required: 0, failed: 1, completed: 4 }, errorsByCode: { PROFILE_NOT_FOUND: 1 }, lostLeases: 0 },
  queue: { waiting: 0, lagSeconds: 0 },
  campaigns: { pendingReview: 2, changesRequired: 0 },
});
const names = (snapshot: OpsSnapshot) => evaluateAlerts(snapshot).map((alert) => alert.name);

describe("enrichment alerts", () => {
  it("raises nothing for a healthy pipeline", () => {
    expect(evaluateAlerts(healthy())).toEqual([]);
  });

  it("pages on queue lag and on running jobs nobody is running", () => {
    const lagging = { ...healthy(), queue: { waiting: 7, lagSeconds: ALERT_THRESHOLDS.queueLagSeconds + 1 } };
    const [alert] = evaluateAlerts(lagging);
    expect(alert).toMatchObject({ name: "enrichment_queue_lag_high", severity: "page", value: 301, threshold: 300 });
    expect(alert!.action).toMatch(/worker and Redis/);
    expect(names({ ...healthy(), queue: { waiting: 1, lagSeconds: ALERT_THRESHOLDS.queueLagSeconds } })).toEqual([]);

    const lost = healthy();
    lost.jobs.lostLeases = 2;
    expect(evaluateAlerts(lost)[0]).toMatchObject({ name: "enrichment_jobs_lost_lease", severity: "page", value: 2 });
  });

  it("tickets on failure rate, worker loss, provider credential and rate-limit errors, each with what to do", () => {
    const failing = healthy();
    failing.jobs.byStatus = { queued: 0, running: 0, partial: 5, action_required: 0, failed: 5, completed: 0 };
    failing.jobs.errorsByCode = { WORKER_LOST: 1, PROVIDER_CREDENTIAL_REJECTED: 2, PROVIDER_RATE_LIMITED: 2 };
    const alerts = evaluateAlerts(failing);
    expect(alerts.map((alert) => alert.name)).toEqual([
      "enrichment_jobs_worker_lost",
      "enrichment_job_failure_rate_high",
      "enrichment_provider_credential_errors",
      "enrichment_provider_rate_limited",
    ]);
    expect(alerts.every((alert) => alert.severity === "ticket" && alert.message && alert.action)).toBe(true);
    expect(alerts.find((alert) => alert.name === "enrichment_provider_rate_limited")!.action).toMatch(/Do not add retries/);

    // Too few finished jobs to call it a rate.
    const small = healthy();
    small.jobs.byStatus = { queued: 0, running: 0, partial: 0, action_required: 0, failed: 3, completed: 1 };
    small.jobs.errorsByCode = {};
    expect(names(small)).toEqual([]);
  });

  it("tickets on abandoned and failing capture runs", () => {
    const captures = healthy();
    captures.captureRuns = { ...captures.captureRuns, abandoned: 1, byStatus: { running: 1, completed: 6, stopped: 0, failed: 3, halted: 0, rejected: 1 } };
    expect(names(captures)).toEqual(["enrichment_capture_runs_abandoned", "enrichment_capture_failure_rate_high"]);
    expect(evaluateAlerts(captures)[1]!.action).toMatch(/kill switch/);
  });

  it("exports gauges labelled only by status and error code", () => {
    const snapshot = healthy();
    snapshot.jobs.errorsByCode = { "PROFILE_NOT_FOUND": 1, 'weird"code\n': 2 };
    const text = formatOpsPrometheus(snapshot);
    expect(text).toContain('skout_enrichment_capture_runs{status="completed"} 20');
    expect(text).toContain('skout_enrichment_jobs{status="partial"} 12');
    expect(text).toContain('skout_enrichment_job_errors{code="PROFILE_NOT_FOUND"} 1');
    expect(text).toContain('skout_enrichment_job_errors{code="weird_code_"} 2');
    expect(text).toContain("skout_enrichment_queue_lag_seconds 0");
    expect(text).toContain("skout_enrichment_campaigns_pending_review 2");
    expect(text).not.toMatch(/workspace|linkedin\.com|@/);
    for (const line of text.split("\n")) expect(line).toMatch(/^(# (HELP|TYPE) skout_enrichment_\w+ .+|skout_enrichment_\w+(\{\w+="\w*"\})? [\d.]+)$/);
  });
});

describe("enrichment ops snapshot", () => {
  it("counts capture runs, jobs, provider errors and queue lag for a workspace", async () => {
    await run({ status: "completed", leadsReceived: 40, leadsRejected: 2 });
    await run({ status: "failed", leadsReceived: 5 });
    await run({ status: "completed", startedAt: minutesAgo(60 * 30) }); // outside the window
    await job({ status: "queued", queuedAt: minutesAgo(10) });
    await job({ status: "queued", queuedAt: minutesAgo(20), nextAttemptAt: new Date(Date.now() + 600_000) }); // retry scheduled: not waiting yet
    await job({ status: "queued", queuedAt: minutesAgo(40), nextAttemptAt: minutesAgo(2) }); // retry now due for two minutes
    await job({ status: "running", leaseExpiresAt: minutesAgo(1) });
    await job({ status: "running", leaseExpiresAt: new Date(Date.now() + 60_000) });
    await job({ status: "failed", errorCode: "WORKER_LOST" });
    await job({ status: "failed", errorCode: "PROVIDER_REQUEST_FAILED" });
    await job({ status: "action_required", errorCode: "PROVIDER_CONNECTION_REQUIRED" });
    await job({ status: "partial" });
    // A waterfall job is not a provider job and is not counted here.
    await db().insert(enrichmentJobs).values({ workspaceId: WORKSPACE, prospectId: "waterfall", status: "failed" });
    await db().insert(enrichmentCampaigns).values([
      { workspaceId: WORKSPACE, name: "A", status: "pending_review" },
      { workspaceId: WORKSPACE, name: "B", status: "changes_required" },
      { workspaceId: WORKSPACE, name: "C", status: "draft" },
    ]);

    const snapshot = await enrichmentOpsSnapshot(db(), WORKSPACE);
    expect(snapshot.captureRuns).toMatchObject({ byStatus: { completed: 1, failed: 1, running: 0 }, abandoned: 0, leadsReceived: 45, leadsRejected: 2 });
    expect(snapshot.jobs.byStatus).toEqual({ queued: 3, running: 2, partial: 1, action_required: 1, failed: 2, completed: 0 });
    expect(snapshot.jobs.errorsByCode).toEqual({ WORKER_LOST: 1, PROVIDER_REQUEST_FAILED: 1, PROVIDER_CONNECTION_REQUIRED: 1 });
    expect(snapshot.jobs.lostLeases).toBe(1);
    expect(snapshot.queue.waiting).toBe(2);
    // The oldest due job has waited ten minutes; the retried one only since it became due.
    expect(snapshot.queue.lagSeconds).toBeGreaterThanOrEqual(595);
    expect(snapshot.queue.lagSeconds).toBeLessThan(700);
    expect(snapshot.campaigns).toEqual({ pendingReview: 1, changesRequired: 1 });
    expect(names(snapshot)).toEqual(expect.arrayContaining(["enrichment_queue_lag_high", "enrichment_jobs_lost_lease", "enrichment_jobs_worker_lost"]));
  });

  it("serves the snapshot and its alerts to workspace administrators only", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/enrichment/ops", headers: owner });
    expect(res.statusCode).toBe(200);
    expect(res.json().snapshot.queue.waiting).toBe(2);
    expect(res.json().alerts.map((alert: { name: string }) => alert.name)).toContain("enrichment_queue_lag_high");
    expect(res.json().alerts[0]).toHaveProperty("action");
    expect((await app.inject({ method: "GET", url: "/api/v1/enrichment/ops", headers: member })).statusCode).toBe(403);
  });

  it("exposes the platform gauges on /metrics", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("skout_api_up 1");
    expect(res.body).toContain("skout_enrichment_metrics_up 1");
    expect(res.body).toMatch(/skout_enrichment_queue_lag_seconds \d+/);
    expect(res.body).toMatch(/skout_enrichment_jobs\{status="queued"\} \d+/);
    // A scrape still answers when the section cannot be read.
    const broken = { select: () => { throw new Error("db down"); } } as never;
    expect(await enrichmentMetricsPrometheus(broken, Date.now() + 10 * 60_000)).toContain("skout_enrichment_metrics_up 0");
    expect(await enrichmentMetricsPrometheus(null)).toBe("");
  });

  it("closes abandoned capture runs on the ops pass and reports the alerts it found", async () => {
    const [stuck] = await run({ status: "running", startedAt: minutesAgo(200), updatedAt: minutesAgo(180) });
    const [live] = await run({ status: "running" });
    const before = await enrichmentOpsSnapshot(db(), WORKSPACE);
    expect(before.captureRuns.abandoned).toBe(1);

    const alerts = await runEnrichmentOpsPass(db());
    expect(alerts.map((alert) => alert.name)).toEqual(expect.arrayContaining(["enrichment_queue_lag_high", "enrichment_jobs_lost_lease"]));
    const rows = await db().select().from(enrichmentCaptureRuns).where(eq(enrichmentCaptureRuns.workspaceId, WORKSPACE));
    expect(rows.find((row) => row.id === stuck!.id)).toMatchObject({ status: "failed", errorCode: "abandoned" });
    expect(rows.find((row) => row.id === live!.id)!.status).toBe("running");
    expect((await enrichmentOpsSnapshot(db(), WORKSPACE)).captureRuns.abandoned).toBe(0);
    expect(await closeAbandonedCaptureRuns(db())).toBe(0);
  });
});
