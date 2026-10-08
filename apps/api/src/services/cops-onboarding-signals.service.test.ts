import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { appendCopsEvent, createCopsEvent } from "@skout/shared";
import { startProvisioning, type ProvisioningContext } from "./cops-provisioning.service.js";
import { ensureActivationInstance } from "./cops-activation.service.js";
import { evaluateOnboarding, listBlockers, loadHandoff, sweepMissedFollowUps } from "./cops-onboarding-signals.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-05 stalled-onboarding playbooks, stop triggers, CS handoff and the WelcomeEmailSent sweep,
 * against a real Postgres. Each trigger fires once; a hard bounce raises a rep task and stops the
 * follow-up; the handoff is created exactly once.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const HOUR = 3_600_000;

maybe("COPS-05 onboarding signals (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ctx: ProvisioningContext;
  let ownerId = "";
  const deps = { config: { EMAIL_INTEL_SERVICE_URL: undefined, EMAIL_INTEL_TIMEOUT_MS: 1000 } as never };

  async function account(opts: { emailStatus?: string; sentHoursAgo?: number; trialDays?: number; credits?: number } = {}) {
    const [company] = await sql`insert into companies (workspace_id, name, owner_id) values (${ctx.workspaceId}, ${"Sig " + randomUUID().slice(0, 6)}, ${ownerId}) returning id`;
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${ctx.workspaceId}, 'P') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'S', 1) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name) values (${ctx.workspaceId}, ${company.id}, ${pipeline.id}, ${stage.id}, 'D') returning id`;
    await sql`insert into commercial_gates (opportunity_id, workspace_id, fired_at, fired_policy) values (${deal.id}, ${ctx.workspaceId}, now(), 'trial_approval_only')`;
    const admin = `adm-${randomUUID().slice(0, 6)}@cust.test`;
    const [contact] = await sql`insert into contacts (workspace_id, company_id, first_name, email) values (${ctx.workspaceId}, ${company.id}, 'Ada', ${admin}) returning id`;
    const { provisioning } = await startProvisioning(db, ctx, company.id, `key-${randomUUID()}`, {
      opportunity_id: deal.id,
      admin_email: admin,
      plan: "trial",
      trial_days: opts.trialDays ?? 14,
      credits: opts.credits ?? 100,
      integrations: ["crm"],
    });
    const instanceId = (await ensureActivationInstance(db, ctx.workspaceId, company.id))!;
    const sentAt = new Date(Date.now() - (opts.sentHoursAgo ?? 1) * HOUR);
    await sql`insert into cops_onboarding_email_sends (workspace_id, account_id, contact_id, to_email, template_key, template_version, subject, idempotency_key, status, sent_at, created_at)
      values (${ctx.workspaceId}, ${company.id}, ${contact.id}, ${admin}, 'welcome_trial', 1, 'Welcome', ${"k-" + randomUUID()}, ${opts.emailStatus ?? "sent"}, ${sentAt}, ${sentAt})`;
    return { accountId: company.id as string, dealId: deal.id as string, admin, contactId: contact.id as string, instanceId, customerWs: provisioning.provisioned_workspace_id! };
  }

  async function withFollowUp(accountId: string) {
    const [seq] = await sql`insert into sequences (workspace_id, name, status, template_key, current_version) values (${ctx.workspaceId}, 'FU', 'active', 'cops_onboarding_followup', 1) returning id`;
    const [step] = await sql`insert into sequence_steps (sequence_id, step_order, step_type, delay_days) values (${seq.id}, 1, 'task', 3) returning id`;
    const [enr] = await sql`insert into sequence_enrollments (workspace_id, sequence_id, prospect_id, status) values (${ctx.workspaceId}, ${seq.id}, ${"p-" + randomUUID()}, 'active') returning id`;
    await sql`insert into sequence_enrollment_steps (enrollment_id, step_id, status, scheduled_at) values (${enr.id}, ${step.id}, 'scheduled', now() + interval '3 days')`;
    await sql`insert into cops_follow_ups (workspace_id, account_id, source_event_id, mode, enrollment_id, created_at) values (${ctx.workspaceId}, ${accountId}, gen_random_uuid(), 'sequence', ${enr.id}, now() - interval '2 hours')`;
    return enr.id as string;
  }

  const enrollmentStatus = async (id: string) => (await sql`select status, stop_reason from sequence_enrollments where id = ${id}`)[0];
  const run = (instanceId: string, now?: Date) => evaluateOnboarding(db, instanceId, deps, { now, correlationId: randomUUID() });

  beforeAll(async () => {
    const [ws] = await sql`insert into workspaces (name, slug) values ('Signals ops', ${"sig-" + randomUUID()}) returning id`;
    [{ id: ownerId }] = await sql`insert into users (email) values (${`owner-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    ctx = { workspaceId: ws.id, userId: ownerId, requestId: randomUUID() };
  });

  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  it("delivered but no login after 24h raises one task for the account owner; a second pass adds nothing", async () => {
    const a = await account({ sentHoursAgo: 25 });
    expect((await run(a.instanceId)).fired).toContain("delivered_no_login");
    expect((await run(a.instanceId)).fired).toEqual([]);
    const [task] = await sql`select t.assigned_to, t.type from cops_onboarding_signals s join tasks t on t.id = s.task_id where s.instance_id = ${a.instanceId} and s.trigger = 'delivered_no_login'`;
    expect(task).toEqual({ assigned_to: ownerId, type: "call" });
    expect((await listBlockers(db, ctx.workspaceId, a.accountId)).map((b) => b.kind)).toContain("delivered_no_login");
  });

  it("a hard bounce raises a rep task and stops the follow-up", async () => {
    const a = await account();
    const enr = await withFollowUp(a.accountId);
    await sql`insert into contact_channels (workspace_id, contact_id, channel, value, bounce_status) values (${ctx.workspaceId}, ${a.contactId}, 'email', ${a.admin}, 'hard')`;
    const r = await run(a.instanceId);
    expect(r.fired).toContain("hard_bounce");
    expect(r.stopped).toContain("HARD_BOUNCE");
    expect(await enrollmentStatus(enr)).toEqual({ status: "stopped", stop_reason: "HARD_BOUNCE" });
  });

  it("an opt-out stops the follow-up (no task)", async () => {
    const a = await account();
    const enr = await withFollowUp(a.accountId);
    await sql`insert into suppressions (workspace_id, email) values (${ctx.workspaceId}, ${a.admin})`;
    const r = await run(a.instanceId);
    expect(r.stopped).toEqual(["OPTED_OUT"]);
    expect(r.fired).toEqual([]);
    expect(await enrollmentStatus(enr)).toEqual({ status: "stopped", stop_reason: "OPTED_OUT" });
  });

  it("a meeting booked after the follow-up started stops it", async () => {
    const a = await account();
    const enr = await withFollowUp(a.accountId);
    await sql`insert into meetings (workspace_id, company_id, title, scheduled_at) values (${ctx.workspaceId}, ${a.accountId}, 'Onboarding call', now() + interval '1 day')`;
    expect((await run(a.instanceId)).stopped).toEqual(["MEETING_BOOKED"]);
    expect(await enrollmentStatus(enr)).toEqual({ status: "stopped", stop_reason: "MEETING_BOOKED" });
  });

  it("the opportunity closed as lost stops the follow-up", async () => {
    const a = await account();
    const enr = await withFollowUp(a.accountId);
    await sql`update deals set status = 'lost' where id = ${a.dealId}`;
    expect((await run(a.instanceId)).stopped).toEqual(["OPPORTUNITY_CLOSED"]);
    expect(await enrollmentStatus(enr)).toMatchObject({ stop_reason: "OPPORTUNITY_CLOSED" });
  });

  it("trial ending, low credits and logged-in-without-value each raise their task once", async () => {
    const a = await account({ trialDays: 2, credits: 100 });
    await sql`update credit_balances set balance = 10 where workspace_id = ${a.customerWs}`;
    await sql`update cops_onboarding_instances set first_login_at = now() - interval '80 hours' where id = ${a.instanceId}`;
    const r = await run(a.instanceId);
    expect(r.fired).toEqual(expect.arrayContaining(["trial_ending", "low_credits", "login_no_value", "no_activity_72h"]));
    expect((await run(a.instanceId)).fired).toEqual([]);
  });

  it("the CS handoff is created exactly once after activation and goes to a CS member", async () => {
    const a = await account();
    const [cs] = await sql`insert into users (email) values (${`cs-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    const [role] = await sql`select id from roles where key = 'cs' and workspace_id is null`;
    await sql`insert into workspace_members (workspace_id, user_id, role) values (${ctx.workspaceId}, ${cs.id}, 'member')`;
    await sql`insert into workspace_member_roles (workspace_id, user_id, role_id) values (${ctx.workspaceId}, ${cs.id}, ${role.id})`;
    await sql`update cops_onboarding_instances set activated_at = now(), activation_pct = 100 where id = ${a.instanceId}`;
    const [first, second] = [await run(a.instanceId), await run(a.instanceId)];
    expect(first.handoff).toBe(true);
    expect(second.handoff).toBe(false);
    const h = (await loadHandoff(db, ctx.workspaceId, a.accountId))!;
    const [task] = await sql`select assigned_to, type from tasks where id = ${h.task_id}`;
    expect(task).toEqual({ assigned_to: cs.id, type: "review" });
    const [owner] = await sql`select owner_id from companies where id = ${a.accountId}`;
    expect(owner.owner_id).toBe(ownerId);
  });

  it("the sweep completes a WelcomeEmailSent that never got its follow-up", async () => {
    const a = await account();
    const [send] = await sql`select id from cops_onboarding_email_sends where account_id = ${a.accountId}`;
    const envelope = await db.transaction(async (tx) =>
      appendCopsEvent(
        tx as never,
        createCopsEvent({
          eventType: "WelcomeEmailSent",
          tenantId: ctx.workspaceId,
          aggregateType: "account",
          aggregateId: a.accountId,
          actor: { type: "user", id: ownerId },
          correlationId: randomUUID(),
          payload: { account_id: a.accountId, email_send_id: send.id },
        })
      )
    );
    await sql`update cops_outbox set created_at = now() - interval '1 hour' where id = ${envelope.event_id}`;
    const n = await sweepMissedFollowUps(db, { ...deps, scheduleFirstStep: vi.fn(async () => {}) });
    expect(n).toBeGreaterThanOrEqual(1);
    const [fu] = await sql`select mode from cops_follow_ups where source_event_id = ${envelope.event_id}`;
    expect(fu.mode).toBe("task");
  });
});
