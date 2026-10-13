import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/**
 * COPS-08 approval engine against a real Postgres (COPS_TEST_DATABASE_URL). Ticket acceptance:
 * editing approved terms voids the approval; sub-threshold deals skip approval with no added step.
 * Also: every approver role must decide, only a holder of the role can decide its slot, an Admin
 * or owner decides the executive slot, a rejection needs a comment, approvals expire, and another
 * workspace sees nothing.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

const stamp = Date.now();
const OWNER = `approvals-owner-${stamp}@example.test`;
const MANAGER = `approvals-manager-${stamp}@example.test`;
const FINANCE = `approvals-finance-${stamp}@example.test`;
const OTHER = `approvals-other-${stamp}@example.test`;

maybe("COPS-08 approval engine", () => {
  let app: FastifyInstance;
  let sql: any;
  let workspaceId = "";
  let opportunityId = "";

  const call = (method: "GET" | "POST" | "PUT", path: string, body?: unknown, email = OWNER) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { "x-stub-user-email": email, ...(method !== "GET" ? { "idempotency-key": randomUUID() } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });

  /** 10 seats at USD 79 for 12 months: under every default threshold. */
  const terms = (over: Record<string, unknown> = {}, discount = 0) => ({
    title: "Approval test",
    currency: "USD",
    billing_cadence: "annual",
    term_months: 12,
    line_items: [{ kind: "seats", description: "Seats", quantity: 10, unit_amount_minor: 94_800, discount_pct: discount }],
    ...over,
  });
  const create = async (body: unknown) => {
    const res = await call("POST", `/opportunities/${opportunityId}/proposals`, body);
    expect(res.statusCode).toBe(201);
    return res.json().data.id as string;
  };
  const evaluate = async (id: string) => (await call("GET", `/proposals/${id}/approvals/evaluate`)).json().data;
  const decide = (approvalId: string, role: string, decision: string, email: string, comment?: string) =>
    call("POST", `/approvals/${approvalId}/decisions`, { role, decision, ...(comment ? { comment } : {}) }, email);

  beforeAll(async () => {
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    const config = loadEnv();
    app = await buildApp({ ...config, DATABASE_URL: url, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined } as typeof config);
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    const [seeded] = await sql`select count(*)::int as n from roles where key = 'finance' and workspace_id is null`;
    if (seeded.n === 0) {
      const backfill = spawnSync("npx", ["tsx", "src/backfill-rbac.ts"], { cwd: new URL("../../../../packages/db/", import.meta.url), env: { ...process.env, DATABASE_URL: url }, shell: true, encoding: "utf8" });
      if (backfill.status !== 0) throw new Error(`backfill-rbac failed: ${backfill.stderr}`);
    }
    await app.ready();
    workspaceId = ((await call("GET", "/me")).json() as { workspaceId: string }).workspaceId;
    await call("GET", "/me", undefined, OTHER);

    // Two colleagues in the owner's workspace, each holding one approver role.
    for (const [email, roleKey] of [[MANAGER, "sales_manager"], [FINANCE, "finance"]] as const) {
      const [user] = await sql`insert into users (email, full_name) values (${email}, ${roleKey}) returning id`;
      await sql`insert into workspace_members (workspace_id, user_id, role) values (${workspaceId}, ${user.id}, 'member')`;
      await sql`insert into workspace_member_roles (workspace_id, user_id, role_id) select ${workspaceId}, ${user.id}, id from roles where key = ${roleKey} and workspace_id is null`;
    }
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${workspaceId}, 'Approvals test') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'Commercial', 1) returning id`;
    const [company] = await sql`insert into companies (workspace_id, name) values (${workspaceId}, ${"Approvals Co " + stamp}) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, amount, currency)
      values (${workspaceId}, ${company.id}, ${pipeline.id}, ${stage.id}, 'Approvals deal', 9480, 'USD') returning id`;
    opportunityId = deal.id;
  });

  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  it("a deal under every threshold needs no approval, and asking for one is refused: no added step", async () => {
    const id = await create(terms());
    const state = await evaluate(id);
    expect(state).toMatchObject({ required: false, satisfied: true, required_approvers: [], approval: null, policy_version: 0 });
    expect(state.terms).toMatchObject({ seats: 10, discount_pct: 0, contract_value_minor: 948_000, payment_terms_net_days: 30 });
    const res = await call("POST", `/proposals/${id}/approvals`);
    expect(res.statusCode).toBe(409);
    const [rows] = await sql`select count(*)::int as n from approvals where proposal_id = ${id}`;
    expect(rows.n).toBe(0);
  });

  it("a discount hidden in line items still counts, and every matching rule adds its approvers", async () => {
    const id = await create(terms({ payment_terms_net_days: 60, custom_clauses: true }, 15));
    const state = await evaluate(id);
    expect(state.terms.discount_pct).toBe(15);
    expect(state.matched_rules.map((m: { rule: string }) => m.rule)).toEqual(["discount_pct", "payment_terms", "custom_clauses"]);
    expect(state.required_approvers).toEqual(["sales_manager", "finance", "legal_revops"]);
    expect(state.satisfied).toBe(false);
  });

  it("request, then each role decides its own slot; the approval is granted only when all have", async () => {
    const id = await create(terms({}, 25));
    const requested = await call("POST", `/proposals/${id}/approvals`);
    expect(requested.statusCode).toBe(201);
    const approval = requested.json().data;
    expect(approval).toMatchObject({ status: "pending", required_approvers: ["sales_manager", "finance"], proposal_version: 1 });
    expect(new Date(approval.expires_at).getTime() - new Date(approval.requested_at).getTime()).toBe(14 * 86_400_000);
    // A second request for the same version is refused.
    expect((await call("POST", `/proposals/${id}/approvals`)).statusCode).toBe(409);

    // The Sales Manager cannot decide the Finance slot, and the owner holds neither role.
    expect((await decide(approval.id, "finance", "approved", MANAGER)).statusCode).toBe(403);
    expect((await decide(approval.id, "sales_manager", "approved", OWNER)).statusCode).toBe(403);
    // A role that is not on this approval has nothing pending.
    expect((await decide(approval.id, "executive", "approved", OWNER)).statusCode).toBe(409);

    const first = await decide(approval.id, "sales_manager", "approved", MANAGER, "Fine for this account");
    expect(first.statusCode).toBe(200);
    expect(first.json().data.status).toBe("pending");
    expect((await evaluate(id)).satisfied).toBe(false);
    // The same slot cannot be decided twice.
    expect((await decide(approval.id, "sales_manager", "approved", MANAGER)).statusCode).toBe(409);

    const second = await decide(approval.id, "finance", "approved", FINANCE);
    expect(second.json().data).toMatchObject({ status: "approved" });
    expect(second.json().data.decisions.find((d: { role: string }) => d.role === "sales_manager")).toMatchObject({ decision: "approved", comment: "Fine for this account" });
    expect((await evaluate(id)).satisfied).toBe(true);

    const audit = await sql`select action from audit_logs where entity_id = ${approval.id} order by created_at`;
    expect(audit.map((a: { action: string }) => a.action)).toEqual(["approval.requested", "approval.approved", "approval.approved"]);
  });

  it("editing approved terms voids the approval; a change to the notes alone does not", async () => {
    const id = await create(terms({}, 15));
    const approval = (await call("POST", `/proposals/${id}/approvals`)).json().data;
    await decide(approval.id, "sales_manager", "approved", MANAGER);
    expect((await evaluate(id)).satisfied).toBe(true);

    // Notes only: the approval moves to the new version.
    const { title: _t, ...v2 } = terms({ notes: "Thanks for your time" }, 15);
    expect((await call("POST", `/proposals/${id}/versions`, v2)).statusCode).toBeLessThan(300);
    const carried = await evaluate(id);
    expect(carried).toMatchObject({ proposal_version: 2, satisfied: true });
    expect(carried.approval).toMatchObject({ id: approval.id, status: "approved", proposal_version: 2 });

    // A deeper discount: the approval is void and a new one is needed.
    const { title: _t2, ...v3 } = terms({ notes: "Thanks for your time" }, 18);
    expect((await call("POST", `/proposals/${id}/versions`, v3)).statusCode).toBeLessThan(300);
    const after = await evaluate(id);
    expect(after).toMatchObject({ proposal_version: 3, satisfied: false, approval: null });
    const [row] = await sql`select status, status_reason from approvals where id = ${approval.id}`;
    expect(row.status).toBe("voided");
    expect(row.status_reason).toContain("discount_pct");
    expect((await call("POST", `/proposals/${id}/approvals`)).statusCode).toBe(201);
  });

  it("a proposal over a threshold cannot be sent until it is approved; one under it sends at once", async () => {
    const under = await create(terms());
    expect((await call("POST", `/proposals/${under}/send`, {})).statusCode).toBe(200);

    const over = await create(terms({}, 15));
    const refused = await call("POST", `/proposals/${over}/send`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "BUSINESS_STATE_CONFLICT", details: { required_approvers: ["sales_manager"], approval_status: "not_requested" } });
    const approval = (await call("POST", `/proposals/${over}/approvals`)).json().data;
    expect((await call("POST", `/proposals/${over}/send`, {})).json().details.approval_status).toBe("pending");
    await decide(approval.id, "sales_manager", "approved", MANAGER);
    expect((await call("POST", `/proposals/${over}/send`, {})).statusCode).toBe(200);
  });

  it("the provisioning gate stays closed while an approval is missing, and the last approval opens it", async () => {
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, amount, currency)
      select workspace_id, company_id, pipeline_id, stage_id, 'Gate and approvals', amount, currency from deals where id = ${opportunityId} returning id`;
    const dealType = `trial-approvals-${stamp}`;
    await call("PUT", "/commercial/gate-policies", { deal_type: dealType, policy: "trial_approval_only" });
    await call("PUT", `/opportunities/${deal.id}/deal-type`, { deal_type: dealType });
    const created = await call("POST", `/opportunities/${deal.id}/proposals`, terms({}, 15));
    const proposalId = created.json().data.id as string;

    // The trial is approved, but the proposal is over a threshold and nobody has approved it.
    const trial = await call("POST", `/opportunities/${deal.id}/gate/approve-trial`, { reason: "Pilot agreed" });
    expect(trial.json().data).toMatchObject({ fired_now: false, open: false });
    const gate = (await call("GET", `/opportunities/${deal.id}/gate`)).json().data;
    expect(gate.conditions).toMatchObject({ trial_approved: true, approvals_complete: false });
    const fired = () => sql`select count(*)::int as n from cops_outbox where event_type = 'ProvisioningRequested' and aggregate_id = ${deal.id}`;
    expect((await fired())[0].n).toBe(0);

    const approval = (await call("POST", `/proposals/${proposalId}/approvals`)).json().data;
    await decide(approval.id, "sales_manager", "approved", MANAGER);
    const after = (await call("GET", `/opportunities/${deal.id}/gate`)).json().data;
    expect(after).toMatchObject({ open: true });
    expect(after.conditions.approvals_complete).toBe(true);
    expect((await fired())[0].n).toBe(1);
  });

  it("an approval that was used in time does not lapse after the proposal has gone out", async () => {
    const id = await create(terms({}, 15));
    const approval = (await call("POST", `/proposals/${id}/approvals`)).json().data;
    await decide(approval.id, "sales_manager", "approved", MANAGER);
    expect((await call("POST", `/proposals/${id}/send`, {})).statusCode).toBe(200);
    await sql`update approvals set expires_at = now() - interval '1 minute' where id = ${approval.id}`;
    expect(await evaluate(id)).toMatchObject({ satisfied: true });
    const [row] = await sql`select status from approvals where id = ${approval.id}`;
    expect(row.status).toBe("approved");
  });

  it("a rejection needs a comment and closes the approval", async () => {
    const id = await create(terms({}, 12));
    const approval = (await call("POST", `/proposals/${id}/approvals`)).json().data;
    expect((await decide(approval.id, "sales_manager", "rejected", MANAGER)).statusCode).toBe(422);
    const rejected = await decide(approval.id, "sales_manager", "rejected", MANAGER, "Too deep for a 10 seat deal");
    expect(rejected.json().data).toMatchObject({ status: "rejected" });
    expect((await evaluate(id)).satisfied).toBe(false);
    // Rejected is not open: the rep can ask again after talking to the manager.
    expect((await call("POST", `/proposals/${id}/approvals`)).statusCode).toBe(201);
  });

  it("an Admin or owner decides the executive slot", async () => {
    const id = await create(terms({}, 35));
    const approval = (await call("POST", `/proposals/${id}/approvals`)).json().data;
    expect(approval.required_approvers).toEqual(["sales_manager", "finance", "executive"]);
    expect((await decide(approval.id, "executive", "approved", FINANCE)).statusCode).toBe(403);
    expect((await decide(approval.id, "executive", "approved", OWNER)).statusCode).toBe(200);
  });

  it("an approval past its expiry no longer counts", async () => {
    const id = await create(terms({}, 15));
    const approval = (await call("POST", `/proposals/${id}/approvals`)).json().data;
    await decide(approval.id, "sales_manager", "approved", MANAGER);
    await sql`update approvals set expires_at = now() - interval '1 minute' where id = ${approval.id}`;
    expect(await evaluate(id)).toMatchObject({ satisfied: false, approval: null });
    const [row] = await sql`select status from approvals where id = ${approval.id}`;
    expect(row.status).toBe("expired");
  });

  it("the queue lists what a role still has to decide, and another workspace sees nothing", async () => {
    const mine = (await call("GET", "/approvals?status=pending&role=finance")).json().data as Array<{ decisions: Array<{ role: string; decision: string }> }>;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((a) => a.decisions.some((d) => d.role === "finance" && d.decision === "pending"))).toBe(true);
    const theirs = await call("GET", "/approvals", undefined, OTHER);
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().data).toEqual([]);
    const [any] = await sql`select id from approvals where workspace_id = ${workspaceId} limit 1`;
    expect((await decide(any.id, "executive", "approved", OTHER)).statusCode).toBe(404);
  });
});
