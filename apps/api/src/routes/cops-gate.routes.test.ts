import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/**
 * COPS-03 provisioning gate against a real Postgres (COPS_TEST_DATABASE_URL).
 * Acceptance: the gate fires exactly once under duplicate/concurrent events; a later payment failure
 * or refund does not undo it (nothing deletes the workspace); manual override needs permission +
 * reason + audit.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (
  url: string,
  options?: object
) => any;

const RUN = Date.now().toString(36);
const OWNER = `gate-owner-${RUN}@example.test`;
const OTHER = `gate-other-${RUN}@example.test`;
const WEBHOOK_SECRET = "whsec_test_gate";
const SHA = "b".repeat(64);

maybe("COPS-03 provisioning gate", () => {
  let app: FastifyInstance;
  let sql: any;
  let workspaceId = "";
  let pipelineId = "";
  let stageId = "";

  const call = (method: "GET" | "POST" | "PUT", path: string, body?: unknown, email = OWNER) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { "x-stub-user-email": email, ...(method !== "GET" ? { "idempotency-key": randomUUID() } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });

  const webhook = (body: object, eventId = `evt_${randomUUID()}`) => {
    const raw = JSON.stringify(body);
    return app.inject({
      method: "POST",
      url: "/api/v1/billing/webhooks/razorpay/payment-links",
      headers: {
        "content-type": "application/json",
        "x-razorpay-event-id": eventId,
        "x-razorpay-signature": createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex"),
      },
      payload: raw,
    });
  };
  const paid = (linkId: string, paymentId = `pay_${randomUUID().slice(0, 8)}`) => ({
    event: "payment_link.paid",
    payload: { payment_link: { entity: { id: linkId, status: "paid" } }, payment: { entity: { id: paymentId } } },
  });

  async function newOpportunity(ws = workspaceId, pipeline = pipelineId, stage = stageId) {
    const [company] = await sql`insert into companies (workspace_id, name) values (${ws}, ${"Gate Co " + randomUUID().slice(0, 6)}) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, currency)
      values (${ws}, ${company.id}, ${pipeline}, ${stage}, 'Gate deal', 'INR') returning id`;
    return { opportunityId: deal.id as string, accountId: company.id as string };
  }
  async function paymentLink(opportunityId: string) {
    const res = await call("POST", "/payment-requests", { opportunity_id: opportunityId, amount_minor: 10_000 });
    expect(res.statusCode).toBe(201);
    return res.json().data.provider_ref as string;
  }
  async function signMsa(opportunityId: string) {
    const c = (await call("POST", `/opportunities/${opportunityId}/contracts`, { kind: "msa", document_url: "https://x.test/msa.pdf", file_sha256: SHA })).json().data;
    await call("POST", `/contracts/${c.id}/send`, {});
    const signed = await call("POST", `/contracts/${c.id}/status`, { status: "signed", reason: "Countersigned PDF received" });
    expect(signed.statusCode).toBe(200);
  }
  const firedEvents = (opportunityId: string) =>
    sql`select envelope from cops_outbox where event_type = 'ProvisioningRequested' and aggregate_id = ${opportunityId}`;
  async function setRole(email: string, roleKey: string) {
    const [u] = await sql`select u.id as user_id, wm.workspace_id from users u join workspace_members wm on wm.user_id = u.id where u.email = ${email}`;
    const [role] = await sql`select id from roles where key = ${roleKey} and workspace_id is null`;
    await sql`delete from workspace_member_roles where workspace_id = ${u.workspace_id} and user_id = ${u.user_id}`;
    await sql`insert into workspace_member_roles (workspace_id, user_id, role_id) values (${u.workspace_id}, ${u.user_id}, ${role.id})`;
    return u.workspace_id as string;
  }

  beforeAll(async () => {
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (target === "https://api.razorpay.com/v1/payment_links") {
        const id = `plink_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
        return new Response(JSON.stringify({ id, short_url: `https://rzp.io/i/${id}`, status: "created" }));
      }
      return realFetch(input, init);
    });
    const config = loadEnv();
    app = await buildApp({
      ...config,
      DATABASE_URL: url,
      CLERK_SECRET_KEY: undefined,
      LOG_LEVEL: "fatal",
      OPENSEARCH_URL: undefined,
      RAZORPAY_KEY_ID: "rzp_test_key",
      RAZORPAY_KEY_SECRET: "rzp_test_secret",
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    } as typeof config);
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    const [roles] = await sql`select count(*)::int as n from roles where key = 'sales'`;
    if (roles.n === 0) {
      const backfill = spawnSync("npx", ["tsx", "src/backfill-rbac.ts"], {
        cwd: new URL("../../../../packages/db/", import.meta.url),
        env: { ...process.env, DATABASE_URL: url },
        shell: true,
        encoding: "utf8",
      });
      if (backfill.status !== 0) throw new Error(`backfill-rbac failed: ${backfill.stderr}`);
    }
    await app.ready();
    workspaceId = ((await call("GET", "/me")).json() as { workspaceId: string }).workspaceId;
    await call("GET", "/me", undefined, OTHER);
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${workspaceId}, 'Gate test') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'Commercial', 1) returning id`;
    pipelineId = pipeline.id;
    stageId = stage.id;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.close();
    await sql?.end();
  });

  it("default policy is signature+payment: signature alone does not fire; payment then fires once", async () => {
    const { opportunityId, accountId } = await newOpportunity();
    const before = (await call("GET", `/opportunities/${opportunityId}/gate`)).json().data;
    expect(before).toMatchObject({ policy: "signature+payment", policy_source: "system_default", open: false, fired_at: null });

    await signMsa(opportunityId);
    expect(await firedEvents(opportunityId)).toHaveLength(0);
    const link = await paymentLink(opportunityId);
    await webhook(paid(link));

    const events = await firedEvents(opportunityId);
    expect(events).toHaveLength(1);
    expect(events[0].envelope.payload).toEqual({ opportunity_id: opportunityId, account_id: accountId, policy: "signature+payment", trigger: "payment" });
    const gate = (await call("GET", `/opportunities/${opportunityId}/gate`)).json().data;
    expect(gate).toMatchObject({ open: true, conditions: { signature_complete: true, payment_complete: true } });
    expect(gate.fired_at).not.toBeNull();

    const [state] = await sql`select state from cops_lifecycle_states where dimension = 'commercial' and entity_id = ${opportunityId}`;
    expect(state.state).toBe("complete");
    const header = (await call("GET", `/accounts/${accountId}/360?fields=header`)).json().data.header;
    expect(header.commercial_state).toBe("complete");
  });

  it("fires exactly once under concurrent paid events for two payment links", async () => {
    const { opportunityId } = await newOpportunity();
    await call("PUT", "/commercial/gate-policies", { deal_type: `concurrent-${RUN}`, policy: "payment" });
    await call("PUT", `/opportunities/${opportunityId}/deal-type`, { deal_type: `concurrent-${RUN}` });
    const [a, b] = [await paymentLink(opportunityId), await paymentLink(opportunityId)];
    const results = await Promise.all([webhook(paid(a)), webhook(paid(b)), webhook(paid(a)), webhook(paid(b))]);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(await firedEvents(opportunityId)).toHaveLength(1);
  });

  it("a later refund or failed payment does not un-fire the gate or remove anything", async () => {
    const { opportunityId } = await newOpportunity();
    await call("PUT", "/commercial/gate-policies", { deal_type: `refund-${RUN}`, policy: "payment" });
    await call("PUT", `/opportunities/${opportunityId}/deal-type`, { deal_type: `refund-${RUN}` });
    const link = await paymentLink(opportunityId);
    const paymentId = `pay_r_${RUN}`;
    await webhook(paid(link, paymentId));
    const [firedBefore] = await sql`select fired_at from commercial_gates where opportunity_id = ${opportunityId}`;

    const refund = await webhook({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_x", payment_id: paymentId } } } });
    expect(refund.json()).toMatchObject({ status: "refunded" });
    const [firedAfter] = await sql`select fired_at from commercial_gates where opportunity_id = ${opportunityId}`;
    expect(firedAfter.fired_at).toEqual(firedBefore.fired_at);
    expect(await firedEvents(opportunityId)).toHaveLength(1);
    const [ws] = await sql`select id from workspaces where id = ${workspaceId}`;
    expect(ws).toBeTruthy();
    // Once fired, the deal type can no longer change the outcome.
    expect((await call("PUT", `/opportunities/${opportunityId}/deal-type`, { deal_type: "other" })).statusCode).toBe(409);
  });

  it("trial_approval_only fires on approval; a DPA signature never counts as the commercial signature", async () => {
    const { opportunityId } = await newOpportunity();
    await call("PUT", "/commercial/gate-policies", { deal_type: `trial-${RUN}`, policy: "trial_approval_only" });
    const typed = (await call("PUT", `/opportunities/${opportunityId}/deal-type`, { deal_type: `trial-${RUN}` })).json().data;
    expect(typed).toMatchObject({ policy: "trial_approval_only", policy_source: "deal_type", open: false });
    expect((await call("POST", `/opportunities/${opportunityId}/gate/approve-trial`, {})).statusCode).toBe(422);
    const approved = await call("POST", `/opportunities/${opportunityId}/gate/approve-trial`, { reason: "Pilot approved by sales manager" });
    expect(approved.json().data).toMatchObject({ fired_now: true, open: true });
    expect(await firedEvents(opportunityId)).toHaveLength(1);

    const second = await newOpportunity();
    await call("PUT", "/commercial/gate-policies", { deal_type: `sig-${RUN}`, policy: "signature" });
    await call("PUT", `/opportunities/${second.opportunityId}/deal-type`, { deal_type: `sig-${RUN}` });
    const dpa = (await call("POST", `/opportunities/${second.opportunityId}/contracts`, { kind: "dpa", document_url: "https://x.test/dpa.pdf", file_sha256: SHA })).json().data;
    await call("POST", `/contracts/${dpa.id}/send`, {});
    await call("POST", `/contracts/${dpa.id}/status`, { status: "signed", reason: "DPA signed" });
    expect(await firedEvents(second.opportunityId)).toHaveLength(0);
    await signMsa(second.opportunityId);
    expect(await firedEvents(second.opportunityId)).toHaveLength(1);
  });

  it("manual_override policy ignores payment; override needs a reason, is audited and fires once", async () => {
    const { opportunityId } = await newOpportunity();
    await call("PUT", "/commercial/gate-policies", { deal_type: `manual-${RUN}`, policy: "manual_override" });
    await call("PUT", `/opportunities/${opportunityId}/deal-type`, { deal_type: `manual-${RUN}` });
    await webhook(paid(await paymentLink(opportunityId)));
    expect(await firedEvents(opportunityId)).toHaveLength(0);

    const noReason = await call("POST", `/opportunities/${opportunityId}/gate/override`, { reason: "" });
    expect(noReason.statusCode).toBe(422);
    const ok = await call("POST", `/opportunities/${opportunityId}/gate/override`, { reason: "Strategic account, CFO approved" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.override).toMatchObject({ reason: "Strategic account, CFO approved" });
    const [audit] = await sql`select is_override, reason from audit_logs where entity_id = ${opportunityId} and action = 'gate.overridden'`;
    expect(audit).toEqual({ is_override: true, reason: "Strategic account, CFO approved" });
    expect((await call("POST", `/opportunities/${opportunityId}/gate/override`, { reason: "again" })).statusCode).toBe(409);
    expect(await firedEvents(opportunityId)).toHaveLength(1);
  });

  it("account commercial summary returns proposals, contracts, payments and the gate", async () => {
    const { opportunityId, accountId } = await newOpportunity();
    await call("POST", `/opportunities/${opportunityId}/proposals`, {
      title: "Summary",
      currency: "INR",
      billing_cadence: "annual",
      term_months: 12,
      line_items: [{ kind: "fee", description: "Setup", quantity: 1, unit_amount_minor: 10_000 }],
    });
    await paymentLink(opportunityId);
    const res = await call("GET", `/accounts/${accountId}/commercial`);
    expect(res.statusCode).toBe(200);
    const [summary] = res.json().data;
    expect(summary.opportunity).toMatchObject({ id: opportunityId, commercial_state: "payment_pending" });
    expect(summary.proposals).toHaveLength(1);
    expect(summary.payment_requests).toHaveLength(1);
    expect(summary.gate).toMatchObject({ policy: "signature+payment", open: false });
  });

  it("Sales cannot override or set policies; Engineering sees no commercial state", async () => {
    const otherWs = await setRole(OTHER, "sales");
    const [pl] = await sql`insert into pipelines (workspace_id, name) values (${otherWs}, 'Other') returning id`;
    const [st] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pl.id}, 'C', 1) returning id`;
    const { opportunityId, accountId } = await newOpportunity(otherWs, pl.id, st.id);
    expect((await call("POST", `/opportunities/${opportunityId}/gate/override`, { reason: "x" }, OTHER)).statusCode).toBe(403);
    expect((await call("PUT", "/commercial/gate-policies", { deal_type: "*", policy: "payment" }, OTHER)).statusCode).toBe(403);
    expect((await call("GET", `/opportunities/${opportunityId}/gate`, undefined, OTHER)).statusCode).toBe(200);

    await sql`insert into cops_lifecycle_states (workspace_id, dimension, entity_id, state) values (${otherWs}, 'commercial', ${opportunityId}, 'payment_pending')`;
    await setRole(OTHER, "engineering");
    expect((await call("GET", `/accounts/${accountId}/commercial`, undefined, OTHER)).statusCode).toBe(403);
    const header = (await call("GET", `/accounts/${accountId}/360?fields=header`, undefined, OTHER)).json().data.header;
    expect(header.commercial_state).toBeNull();
  });
});
