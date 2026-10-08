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

  it("Engineering cannot send or read onboarding email", async () => {
    const { accountId } = await provisioned();
    await asRole("engineering");
    expect((await call("POST", `/accounts/${accountId}/onboarding/send`, {})).statusCode).toBe(403);
    expect((await call("GET", `/accounts/${accountId}/onboarding/emails`)).statusCode).toBe(403);
  });
});
