import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/**
 * COPS-04 routes against a real Postgres: permissions per role, Idempotency-Key rules, the same key
 * returning the same provisioning, 409s, wallet grant/adjust/extend through HTTP.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

const RUN = Date.now().toString(36);
const OWNER = `prov-owner-${RUN}@example.test`;

maybe("COPS-04 provisioning routes", () => {
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

  async function account(fired = true) {
    const [company] = await sql`insert into companies (workspace_id, name) values (${workspaceId}, ${"Route Co " + randomUUID().slice(0, 6)}) returning id`;
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${workspaceId}, 'P') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'S', 1) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name) values (${workspaceId}, ${company.id}, ${pipeline.id}, ${stage.id}, 'D') returning id`;
    if (fired) await sql`insert into commercial_gates (opportunity_id, workspace_id, fired_at, fired_policy) values (${deal.id}, ${workspaceId}, now(), 'trial_approval_only')`;
    return { accountId: company.id as string, body: { opportunity_id: deal.id as string, admin_email: `adm-${randomUUID().slice(0, 6)}@cust.test` } };
  }

  beforeAll(async () => {
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    const config = loadEnv();
    app = await buildApp({ ...config, DATABASE_URL: url, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined } as typeof config);
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

  it("CS provisions; the same key returns 200 with the same provisioning; a new key gets 409", async () => {
    await asRole("cs");
    const { accountId, body } = await account();
    const key = `prov-${randomUUID()}`;
    const first = await call("POST", `/accounts/${accountId}/provision`, body, key);
    expect(first.statusCode).toBe(201);
    const data = first.json().data;
    expect(data).toMatchObject({ status: "succeeded", plan: "trial", credits: 500, within_target: true });
    expect(data.steps).toHaveLength(7);
    expect(data.admin_invite.accept_url).toMatch(/\/invite\/[a-f0-9]{64}$/);

    const replay = await call("POST", `/accounts/${accountId}/provision`, body, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(data.id);

    const second = await call("POST", `/accounts/${accountId}/provision`, body);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "ALREADY_PROVISIONED", details: { provisioning_id: data.id } });

    const list = await call("GET", `/accounts/${accountId}/provisioning`);
    expect(list.json().data.map((p: { id: string }) => p.id)).toEqual([data.id]);
  });

  it("rejects a missing Idempotency-Key, a bad body, a closed gate, and roles without permission", async () => {
    await asRole("cs");
    const { accountId, body } = await account(false);
    expect((await call("POST", `/accounts/${accountId}/provision`, body, null)).statusCode).toBe(422);
    const bad = await call("POST", `/accounts/${accountId}/provision`, { ...body, trial_days: 500 });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().details.fields[0].path).toBe("trial_days");
    const closed = await call("POST", `/accounts/${accountId}/provision`, body);
    expect(closed.statusCode).toBe(409);
    expect(closed.json().code).toBe("GATE_CLOSED");
    await asRole("engineering");
    expect((await call("POST", `/accounts/${accountId}/provision`, body)).statusCode).toBe(403);
    expect((await call("GET", `/accounts/${accountId}/credits`)).statusCode).toBe(403);
  });

  it("Finance grants and adjusts with a reason; CS cannot; a replayed grant is applied once", async () => {
    await asRole("cs");
    const { accountId, body } = await account();
    expect((await call("POST", `/accounts/${accountId}/provision`, body)).statusCode).toBe(201);
    expect((await call("POST", `/accounts/${accountId}/credits/grants`, { amount: 10, reason: "x" })).statusCode).toBe(403);

    await asRole("finance");
    expect((await call("POST", `/accounts/${accountId}/credits/grants`, { amount: 10 })).statusCode).toBe(422);
    const key = `grant-${randomUUID()}`;
    const grant = await call("POST", `/accounts/${accountId}/credits/grants`, { amount: 100, reason: "Goodwill" }, key);
    expect(grant.statusCode).toBe(201);
    expect(grant.json().data).toMatchObject({ kind: "grant", amount: 100, balance: 600, reason: "Goodwill" });
    const replay = await call("POST", `/accounts/${accountId}/credits/grants`, { amount: 100, reason: "Goodwill" }, key);
    expect(replay.json().data.id).toBe(grant.json().data.id);

    const tooMuch = await call("POST", `/accounts/${accountId}/credits/adjustments`, { amount: -5000, reason: "Clawback" });
    expect(tooMuch.statusCode).toBe(409);
    expect(tooMuch.json().code).toBe("INSUFFICIENT_CREDITS");
    const fix = await call("POST", `/accounts/${accountId}/credits/adjustments`, {
      amount: -100,
      reason: "Reverse goodwill",
      compensates_id: grant.json().data.id,
    });
    expect(fix.statusCode).toBe(201);
    const wallet = (await call("GET", `/accounts/${accountId}/credits`)).json().data;
    expect(wallet.balance).toBe(500);
    expect(wallet.ledger.map((e: { kind: string }) => e.kind)).toEqual(["adjustment", "grant", "grant"]);

    const recon = (await call("GET", "/credits/reconciliation")).json().data;
    expect(recon.wallets.find((w: { account_id: string }) => w.account_id === accountId)).toMatchObject({ ok: true });
  });

  it("CS extends a trial with a reason", async () => {
    await asRole("cs");
    const { accountId, body } = await account();
    const prov = (await call("POST", `/accounts/${accountId}/provision`, body)).json().data;
    expect((await call("POST", `/accounts/${accountId}/trial/extend`, { days: 7 })).statusCode).toBe(422);
    const res = await call("POST", `/accounts/${accountId}/trial/extend`, { days: 7, reason: "Security review" });
    expect(res.statusCode).toBe(200);
    expect(new Date(res.json().data.trial_ends_at).getTime() - new Date(prov.trial_ends_at).getTime()).toBe(7 * 86_400_000);
  });
});
