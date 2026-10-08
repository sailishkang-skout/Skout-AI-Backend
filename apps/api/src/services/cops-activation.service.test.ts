import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { startProvisioning, type ProvisioningContext } from "./cops-provisioning.service.js";
import { activationPct, completeManualMilestone, ensureActivationInstance, evaluateActivation, isActivated, loadActivation } from "./cops-activation.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-05 activation against a real Postgres. Acceptance: login alone never activates; a template
 * change does not rewrite past activations; product data satisfies milestones; activation stops
 * the follow-up. Plus manual milestones and evidence.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

describe("activation math", () => {
  it("weights completed milestones and activates only when every required one is done", () => {
    const d = new Date();
    expect(activationPct([{ weight: 35, completedAt: d }, { weight: 30, completedAt: null }, { weight: 35, completedAt: d }, { weight: 0, completedAt: d }])).toBe(70);
    expect(activationPct([{ weight: 0, completedAt: d }])).toBe(0);
    expect(isActivated([{ required: true, completedAt: d }, { required: false, completedAt: null }])).toBe(true);
    expect(isActivated([{ required: true, completedAt: d }, { required: true, completedAt: null }])).toBe(false);
    // A template with no required milestone never activates (login alone cannot).
    expect(isActivated([{ required: false, completedAt: d }])).toBe(false);
  });
});

maybe("COPS-05 activation (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ctx: ProvisioningContext;

  async function provisioned() {
    const [company] = await sql`insert into companies (workspace_id, name) values (${ctx.workspaceId}, ${"Act " + randomUUID().slice(0, 6)}) returning id`;
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${ctx.workspaceId}, 'P') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'S', 1) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name) values (${ctx.workspaceId}, ${company.id}, ${pipeline.id}, ${stage.id}, 'D') returning id`;
    await sql`insert into commercial_gates (opportunity_id, workspace_id, fired_at, fired_policy) values (${deal.id}, ${ctx.workspaceId}, now(), 'trial_approval_only')`;
    const { provisioning } = await startProvisioning(db, ctx, company.id, `key-${randomUUID()}`, {
      opportunity_id: deal.id,
      admin_email: `adm-${randomUUID().slice(0, 6)}@cust.test`,
      plan: "trial",
      trial_days: 14,
      credits: 100,
      integrations: ["crm"],
    });
    const accountId = company.id as string;
    const instanceId = (await ensureActivationInstance(db, ctx.workspaceId, accountId))!;
    return { accountId, instanceId, customerWs: provisioning.provisioned_workspace_id! };
  }

  /** The customer's admin signs in (a member of the provisioned workspace with a login_success event). */
  async function adminLogsIn(customerWs: string) {
    const [u] = await sql`insert into users (email) values (${`member-${randomUUID().slice(0, 8)}@cust.test`}) returning id`;
    await sql`insert into workspace_members (workspace_id, user_id, role) values (${customerWs}, ${u.id}, 'owner')`;
    await sql`insert into auth_events (user_id, type) values (${u.id}, 'login_success')`;
    return u.id as string;
  }
  const productUse = (customerWs: string, action: string) =>
    sql`insert into credit_transactions (workspace_id, amount, action, kind) values (${customerWs}, -1, ${action}, 'consume')`;

  beforeAll(async () => {
    const [ws] = await sql`insert into workspaces (name, slug) values ('Activation ops', ${"act-" + randomUUID()}) returning id`;
    const [user] = await sql`insert into users (email) values (${`cs-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    ctx = { workspaceId: ws.id, userId: user.id, requestId: randomUUID() };
  });

  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  it("creates one instance per account, pinned to the template version, with the template's milestones", async () => {
    const a = await provisioned();
    expect(await ensureActivationInstance(db, ctx.workspaceId, a.accountId)).toBe(a.instanceId);
    const act = (await loadActivation(db, ctx.workspaceId, a.accountId))!;
    expect(act).toMatchObject({ template_key: "default_trial", template_version: 1, activation_pct: 0, activated_at: null });
    expect(act.milestones.filter((m) => m.required).map((m) => m.key).sort()).toEqual(["crm_connected", "first_export", "first_search"]);
  });

  it("login alone never activates: first login is recorded (FirstLogin) but activation stays 0%", async () => {
    const a = await provisioned();
    const userId = await adminLogsIn(a.customerWs);
    await evaluateActivation(db, ctx.workspaceId, a.instanceId, randomUUID());
    const act = (await loadActivation(db, ctx.workspaceId, a.accountId))!;
    expect(act.first_login_at).not.toBeNull();
    expect(act.activation_pct).toBe(0);
    expect(act.activated_at).toBeNull();
    const [ev] = await sql`select envelope->'payload' as p from cops_outbox where event_type = 'FirstLogin' and aggregate_id = ${a.accountId}`;
    expect(ev.p.user_id).toBe(userId);
    expect((await sql`select count(*)::int as n from cops_outbox where event_type = 'CustomerActivated' and aggregate_id = ${a.accountId}`)[0].n).toBe(0);
  });

  it("product data completes milestones with evidence, activates once, and stops the follow-up", async () => {
    const a = await provisioned();
    const [seq] = await sql`insert into sequences (workspace_id, name, status, template_key, current_version) values (${ctx.workspaceId}, 'FU', 'active', 'cops_onboarding_followup', 1) returning id`;
    const [step] = await sql`insert into sequence_steps (sequence_id, step_order, step_type, delay_days) values (${seq.id}, 1, 'task', 3) returning id`;
    const [enr] = await sql`insert into sequence_enrollments (workspace_id, sequence_id, prospect_id, status) values (${ctx.workspaceId}, ${seq.id}, ${"p-" + randomUUID()}, 'active') returning id`;
    await sql`insert into sequence_enrollment_steps (enrollment_id, step_id, status, scheduled_at) values (${enr.id}, ${step.id}, 'scheduled', now() + interval '3 days')`;
    await sql`insert into cops_follow_ups (workspace_id, account_id, source_event_id, mode, enrollment_id) values (${ctx.workspaceId}, ${a.accountId}, gen_random_uuid(), 'sequence', ${enr.id})`;

    await sql`insert into crm_connections (workspace_id, provider, status) values (${a.customerWs}, 'hubspot', 'connected')`;
    await productUse(a.customerWs, "search");
    expect((await evaluateActivation(db, ctx.workspaceId, a.instanceId, randomUUID())).activated).toBe(false);
    expect((await loadActivation(db, ctx.workspaceId, a.accountId))!.activation_pct).toBe(65);

    await productUse(a.customerWs, "export_hubspot");
    const r = await evaluateActivation(db, ctx.workspaceId, a.instanceId, randomUUID());
    expect(r.activated).toBe(true);
    const act = (await loadActivation(db, ctx.workspaceId, a.accountId))!;
    expect(act.activation_pct).toBe(100);
    expect(act.activated_at).not.toBeNull();
    expect(act.milestones.find((m) => m.key === "first_export")!.evidence).toMatchObject({ source_type: "product.export", action: "export_hubspot" });

    // Re-evaluating changes nothing and never emits a second activation.
    await evaluateActivation(db, ctx.workspaceId, a.instanceId, randomUUID());
    expect((await sql`select count(*)::int as n from cops_outbox where event_type = 'CustomerActivated' and aggregate_id = ${a.accountId}`)[0].n).toBe(1);
    const [rule] = await sql`select envelope->'payload'->>'rule_version' as v from cops_outbox where event_type = 'CustomerActivated' and aggregate_id = ${a.accountId}`;
    expect(rule.v).toBe("default_trial@v1");
    const [e] = await sql`select status, stop_reason from sequence_enrollments where id = ${enr.id}`;
    expect(e).toEqual({ status: "stopped", stop_reason: "ACTIVATED" });
  });

  it("a new template version does not touch an existing instance or its past activation", async () => {
    const a = await provisioned();
    const [sys] = await sql`select milestones from cops_activation_templates where workspace_id is null and key = 'default_trial' and version = 1`;
    const v2 = (sys.milestones as Array<Record<string, unknown>>).map((m) => (m.key === "team_invited" ? { ...m, required: true, weight: 20 } : m));
    await sql`insert into cops_activation_templates (workspace_id, key, version, milestones) values (${ctx.workspaceId}, 'default_trial', 2, ${sql.json(v2)})`;
    const before = (await loadActivation(db, ctx.workspaceId, a.accountId))!;
    expect(before.template_version).toBe(1);
    expect(before.milestones.find((m) => m.key === "team_invited")!.required).toBe(false);
    // A newly provisioned account takes the newest version.
    const b = await provisioned();
    expect((await loadActivation(db, ctx.workspaceId, b.accountId))!.template_version).toBe(2);
  });

  it("a manual milestone needs a reason-bearing person; event milestones cannot be completed by hand", async () => {
    const a = await provisioned();
    const act = await completeManualMilestone(db, ctx, a.accountId, "success_review", "Reviewed goals with the champion", randomUUID());
    const m = act!.milestones.find((x) => x.key === "success_review")!;
    expect(m.completed_at).not.toBeNull();
    expect(m.evidence).toMatchObject({ source_type: "manual", reason: "Reviewed goals with the champion" });
    await expect(completeManualMilestone(db, ctx, a.accountId, "first_search", "said so", randomUUID())).rejects.toMatchObject({ code: "BUSINESS_STATE_CONFLICT" });
    await expect(completeManualMilestone(db, ctx, a.accountId, "success_review", "again", randomUUID())).rejects.toMatchObject({ code: "BUSINESS_STATE_CONFLICT" });
    const [audit] = await sql`select action, reason, is_override from audit_logs where action = 'milestone.completed' and workspace_id = ${ctx.workspaceId} order by created_at desc limit 1`;
    expect(audit).toMatchObject({ reason: "Reviewed goals with the champion", is_override: true });
  });
});
