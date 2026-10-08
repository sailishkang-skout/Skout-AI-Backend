import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/**
 * COPS-05 onboarding email routes against a real Postgres: who may send (Sales and CS, not
 * Engineering), Idempotency-Key required, the not-provisioned and blocked-contact errors, and the
 * retryable 502 when no email provider is configured (the test env has none).
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

const RUN = Date.now().toString(36);
const OWNER = `onb-owner-${RUN}@example.test`;

maybe("COPS-05 onboarding email routes", () => {
  let app: FastifyInstance;
  let sql: any;
  let workspaceId = "";
  let userId = "";

  const call = (method: "GET" | "POST", path: string, body?: unknown, key: string | null = randomUUID()) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { "x-stub-user-email": OWNER, ...(method === "POST" && key ? { "idempotency-key": key } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });

  async function asRole(roleKey: string) {
    const [role] = await sql`select id from roles where key = ${roleKey} and workspace_id is null`;
    await sql`delete from workspace_member_roles where workspace_id = ${workspaceId} and user_id = ${userId}`;
    await sql`insert into workspace_member_roles (workspace_id, user_id, role_id) values (${workspaceId}, ${userId}, ${role.id})`;
  }

  async function provisioned() {
    const [company] = await sql`insert into companies (workspace_id, name) values (${workspaceId}, ${"Onb Co " + randomUUID().slice(0, 6)}) returning id`;
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${workspaceId}, 'P') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'S', 1) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name) values (${workspaceId}, ${company.id}, ${pipeline.id}, ${stage.id}, 'D') returning id`;
    await sql`insert into commercial_gates (opportunity_id, workspace_id, fired_at, fired_policy) values (${deal.id}, ${workspaceId}, now(), 'trial_approval_only')`;
    const admin = `adm-${randomUUID().slice(0, 6)}@cust.test`;
    await asRole("cs");
    const res = await call("POST", `/accounts/${company.id}/provision`, { opportunity_id: deal.id, admin_email: admin });
    expect(res.statusCode).toBe(201);
    return { accountId: company.id as string, admin };
  }

  beforeAll(async () => {
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    const config = loadEnv();
    app = await buildApp({
      ...config,
      DATABASE_URL: url,
      CLERK_SECRET_KEY: undefined,
      LOG_LEVEL: "fatal",
      OPENSEARCH_URL: undefined,
      RESEND_API_KEY: undefined,
      SMTP_HOST: undefined,
    } as typeof config);
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    await app.ready();
    workspaceId = ((await call("GET", "/me")).json() as { workspaceId: string }).workspaceId;
    const [u] = await sql`select id from users where email = ${OWNER}`;
    userId = u.id;
  });

  afterAll(async () => {
    const rows = await sql`select provisioned_workspace_id as id from cops_provisionings where workspace_id = ${workspaceId} and provisioned_workspace_id is not null`;
    for (const r of rows) await sql`delete from workspaces where id = ${r.id}`;
    await app?.close();
    await sql?.end();
  });

  it("Sales can preview; the preview shows the recipient and that nothing blocks it", async () => {
    const { accountId, admin } = await provisioned();
    await asRole("sales");
    const res = await call("POST", `/accounts/${accountId}/onboarding/preview`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ template_key: "welcome_trial", to: admin, blocked: null });
  });

  it("send needs an Idempotency-Key and a provisioned account", async () => {
    await asRole("cs");
    const { accountId } = await provisioned();
    const noKey = await call("POST", `/accounts/${accountId}/onboarding/send`, {}, null);
    expect(noKey.statusCode).toBe(422);
    expect(noKey.json().details.fields[0].path).toBe("Idempotency-Key");
    const [bare] = await sql`insert into companies (workspace_id, name) values (${workspaceId}, 'Bare') returning id`;
    const notProv = await call("POST", `/accounts/${bare.id}/onboarding/send`, {});
    expect(notProv.statusCode).toBe(404);
    expect(notProv.json().code).toBe("NOT_PROVISIONED");
  });

  it("without an email provider the send is a retryable 502 and the email list shows it failed", async () => {
    const { accountId } = await provisioned();
    const res = await call("POST", `/accounts/${accountId}/onboarding/send`, {});
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "EMAIL_NOT_SENT", retryable: true });
    const list = (await call("GET", `/accounts/${accountId}/onboarding/emails`)).json().data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "failed", template_key: "welcome_trial" });
  });

  it("a suppressed recipient is refused with 409 CONTACT_BLOCKED", async () => {
    const { accountId, admin } = await provisioned();
    await sql`insert into suppressions (workspace_id, email) values (${workspaceId}, ${admin})`;
    const res = await call("POST", `/accounts/${accountId}/onboarding/send`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "CONTACT_BLOCKED", details: { reason: "suppressed" } });
  });

  it("a re-send without a reason is a 422 with the field path", async () => {
    const { accountId } = await provisioned();
    const res = await call("POST", `/accounts/${accountId}/onboarding/send`, { resend: true });
    expect(res.statusCode).toBe(422);
    expect(res.json().details.fields[0].path).toBe("reason");
  });

  it("the rep sees the follow-up and can pause (reason required), resume and stop it", async () => {
    await asRole("sales");
    const { accountId } = await provisioned();
    await asRole("sales");
    const [seq] = await sql`insert into sequences (workspace_id, name, status, template_key, current_version) values (${workspaceId}, 'FU', 'active', 'cops_onboarding_followup', 1) returning id`;
    const [step] = await sql`insert into sequence_steps (sequence_id, step_order, step_type, delay_days) values (${seq.id}, 1, 'task', 1) returning id`;
    const [ver] = await sql`insert into sequence_versions (sequence_id, version, snapshot) values (${seq.id}, 1, '{}'::jsonb) returning id`;
    const [enr] = await sql`insert into sequence_enrollments (workspace_id, sequence_id, prospect_id, status, sequence_version_id) values (${workspaceId}, ${seq.id}, ${"p-" + randomUUID()}, 'active', ${ver.id}) returning id`;
    await sql`insert into sequence_enrollment_steps (enrollment_id, step_id, status, scheduled_at) values (${enr.id}, ${step.id}, 'scheduled', now() + interval '1 day')`;
    await sql`insert into cops_follow_ups (workspace_id, account_id, source_event_id, mode, enrollment_id) values (${workspaceId}, ${accountId}, gen_random_uuid(), 'sequence', ${enr.id})`;

    const view = (await call("GET", `/accounts/${accountId}/follow-up/enrollment`)).json().data;
    expect(view).toMatchObject({ mode: "sequence", enrollment: { id: enr.id, status: "active", template_version: 1, current_step: 1, next_action: { kind: "task" } } });

    expect((await call("POST", `/follow-up/enrollments/${enr.id}/pause`, {})).statusCode).toBe(422);
    expect((await call("POST", `/follow-up/enrollments/${enr.id}/pause`, { reason: "Customer on leave" })).statusCode).toBe(200);
    expect((await call("POST", `/follow-up/enrollments/${enr.id}/pause`, { reason: "again" })).json().code).toBe("NOT_ACTIVE");
    expect((await call("POST", `/follow-up/enrollments/${enr.id}/resume`, {})).statusCode).toBe(200);
    expect((await call("POST", `/follow-up/enrollments/${enr.id}/stop`, { reason: "Closed by phone" })).statusCode).toBe(200);
    const again = await call("POST", `/follow-up/enrollments/${enr.id}/stop`, { reason: "twice" });
    expect(again.statusCode).toBe(409);
    const after = (await call("GET", `/accounts/${accountId}/follow-up/enrollment`)).json().data;
    expect(after.enrollment).toMatchObject({ status: "stopped", stop_reason: "REP_STOPPED", next_action: null });
  });

  it("Onboarding Control loads in one call; manual milestones need a reason, event ones refuse", async () => {
    await asRole("cs");
    const { accountId } = await provisioned();
    const res = await call("GET", `/accounts/${accountId}/onboarding`);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ account_id: accountId, trial_days_left: 14, follow_up: null, emails: [], blockers: [], handoff: null });
    expect(data.activation).toMatchObject({ template_key: "default_trial", activation_pct: 0 });

    const path = `/accounts/${accountId}/activation/milestones`;
    expect((await call("POST", `${path}/success_review/complete`, {})).statusCode).toBe(422);
    const ok = await call("POST", `${path}/success_review/complete`, { reason: "Success review held" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.milestones.find((m: { key: string }) => m.key === "success_review").completed_at).not.toBeNull();
    const ev = await call("POST", `${path}/first_search/complete`, { reason: "trust me" });
    expect(ev.statusCode).toBe(409);
    expect((await call("POST", `${path}/nope/complete`, { reason: "x" })).statusCode).toBe(404);
    const [bare] = await sql`insert into companies (workspace_id, name) values (${workspaceId}, 'Bare 2') returning id`;
    expect((await call("GET", `/accounts/${bare.id}/onboarding`)).statusCode).toBe(404);
  });

  it("Engineering cannot send or read onboarding email", async () => {
    const { accountId } = await provisioned();
    await asRole("engineering");
    expect((await call("POST", `/accounts/${accountId}/onboarding/send`, {})).statusCode).toBe(403);
    expect((await call("GET", `/accounts/${accountId}/onboarding/emails`)).statusCode).toBe(403);
    expect((await call("POST", `/follow-up/enrollments/${randomUUID()}/stop`, { reason: "x" })).statusCode).toBe(403);
  });
});
