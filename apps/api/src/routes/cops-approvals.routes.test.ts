import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { handleDexterEvent } from "../workers/dexter-event.worker.js";

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

  it("contract value is TCV: a per-month price is multiplied by the term, so it cannot slip under the limit", async () => {
    // 30 seats at USD 79 a month for 12 months is USD 28,440: over the 25k limit, and over 25 seats.
    const id = await create(terms({ line_items: [{ kind: "seats", description: "Seats", quantity: 30, unit_amount_minor: 7900, price_basis: "per_month" }] }));
    const state = await evaluate(id);
    expect(state.terms.contract_value_minor).toBe(2_844_000);
    expect(state.matched_rules.map((m: { rule: string }) => m.rule)).toEqual(["seats", "contract_value"]);
    const proposal = (await call("GET", `/proposals/${id}`)).json().data;
    expect(proposal.versions[0].line_items[0].price_basis).toBe("per_month");
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

    // The Sales Manager cannot decide the Finance slot (the owner may decide any slot; see below).
    expect((await decide(approval.id, "finance", "approved", MANAGER)).statusCode).toBe(403);
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

    // One event when it is asked for and one when it is granted; the worker notifies by role from these.
    const events = await sql`select event_type, envelope->'payload' as payload from cops_outbox where aggregate_id = ${id} and event_type like 'Approval%' order by created_at`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(["ApprovalRequested", "ApprovalDecided"]);
    expect(events[0].payload).toMatchObject({ approval_id: approval.id, required_approvers: ["sales_manager", "finance"] });
    expect(events[1].payload).toMatchObject({ status: "approved" });

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
    const [voided] = await sql`select envelope->'payload' as payload from cops_outbox where aggregate_id = ${id} and event_type = 'ApprovalDecided' and envelope->'payload'->>'status' = 'voided'`;
    expect(voided.payload.reason).toContain("discount_pct");
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

  it("a deal already in flight before COPS-08 is skipped by the engine and listed for Finance", async () => {
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, amount, currency)
      select workspace_id, company_id, pipeline_id, stage_id, 'Old signed deal', amount, currency from deals where id = ${opportunityId} returning id`;
    const proposalId = (await call("POST", `/opportunities/${deal.id}/proposals`, terms({}, 35))).json().data.id as string;
    expect((await evaluate(proposalId)).satisfied).toBe(false);
    // What migration 0126 writes for a deal that had a sent proposal when it ran.
    await sql`insert into commercial_gates (opportunity_id, workspace_id, approvals_grandfathered_at, approvals_grandfathered_reason)
      values (${deal.id}, ${workspaceId}, now(), 'contract_signed,proposal_sent')
      on conflict (opportunity_id) do update set approvals_grandfathered_at = now(), approvals_grandfathered_reason = 'contract_signed,proposal_sent'`;

    const state = await evaluate(proposalId);
    expect(state).toMatchObject({ grandfathered: true, required: false, satisfied: true });
    // The rules are still shown, so Finance can see what would have applied.
    expect(state.required_approvers).toEqual(["sales_manager", "finance", "executive"]);
    expect((await call("POST", `/proposals/${proposalId}/approvals`)).statusCode).toBe(409);
    expect((await call("POST", `/proposals/${proposalId}/send`, {})).statusCode).toBe(200);
    expect((await call("GET", `/opportunities/${deal.id}/gate`)).json().data.conditions.approvals_complete).toBe(true);

    const report = (await call("GET", "/approvals/grandfathered")).json().data as Array<{ opportunity_id: string; reasons: string[]; opportunity_name: string }>;
    expect(report.find((r) => r.opportunity_id === deal.id)).toMatchObject({ opportunity_name: "Old signed deal", reasons: ["contract_signed", "proposal_sent"] });
    expect((await call("GET", "/approvals/grandfathered", undefined, OTHER)).json().data).toEqual([]);
  });

  it("the approvers get an in-app notification, each once, and nobody else does", async () => {
    const id = await create(terms({}, 25));
    await call("POST", `/proposals/${id}/approvals`);
    const [row] = await sql`select envelope from cops_outbox where aggregate_id = ${id} and event_type = 'ApprovalRequested'`;
    // What the event worker does with the outbox row, run twice to prove it does not notify twice.
    await handleDexterEvent(row.envelope, (app as unknown as { db: never }).db);
    await handleDexterEvent(row.envelope, (app as unknown as { db: never }).db);
    const sent = await sql`select u.email, n.type, n.entity_id from notifications n join users u on u.id = n.user_id where n.source_event_id = ${row.envelope.event_id} order by u.email`;
    expect(sent.map((n: { email: string }) => n.email)).toEqual([FINANCE, MANAGER].sort());
    expect(sent[0]).toMatchObject({ type: "cops.ApprovalRequested", entity_id: id });
  });

  it("the stage rule: an opportunity cannot be marked won while a proposal is waiting for approval", async () => {
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, amount, currency)
      select workspace_id, company_id, pipeline_id, stage_id, 'Stage rule deal', amount, currency from deals where id = ${opportunityId} returning id`;
    const move = (to: string) => call("POST", `/cops/lifecycle/opportunity/${deal.id}/transitions`, { to, source: "test", reason: "moving the deal" });
    expect((await move("demo")).statusCode).toBeLessThan(300);
    expect((await move("commercial")).statusCode).toBeLessThan(300);
    const proposalId = (await call("POST", `/opportunities/${deal.id}/proposals`, terms({}, 15))).json().data.id as string;

    const blocked = await move("won");
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "BUSINESS_STATE_CONFLICT", details: { requested_state: "won" } });
    expect(blocked.json().message).toContain("needs approval from sales_manager");
    expect((await sql`select state from cops_lifecycle_states where dimension = 'opportunity' and entity_id = ${deal.id}`)[0].state).toBe("commercial");
    // Losing the deal is always allowed.
    const approval = (await call("POST", `/proposals/${proposalId}/approvals`)).json().data;
    await decide(approval.id, "sales_manager", "approved", MANAGER);
    expect((await move("won")).statusCode).toBeLessThan(300);
  });

  it("the currency is locked once a proposal has been sent: no later version or second proposal in another currency", async () => {
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, amount, currency)
      select workspace_id, company_id, pipeline_id, stage_id, 'Currency lock deal', amount, currency from deals where id = ${opportunityId} returning id`;
    const make = (currency: string) => call("POST", `/opportunities/${deal.id}/proposals`, terms({ currency }));
    const first = (await make("USD")).json().data.id as string;
    const { title: _t, ...usd } = terms();
    // Before anything is sent the currency can still change.
    expect((await call("POST", `/proposals/${first}/versions`, { ...usd, currency: "EUR" })).statusCode).toBeLessThan(300);
    expect((await call("POST", `/proposals/${first}/versions`, usd)).statusCode).toBeLessThan(300);
    expect((await call("POST", `/proposals/${first}/send`, {})).statusCode).toBe(200);

    const changed = await call("POST", `/proposals/${first}/versions`, { ...usd, currency: "EUR" });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: "BUSINESS_STATE_CONFLICT", details: { locked_currency: "USD", requested_currency: "EUR" } });
    expect((await make("GBP")).statusCode).toBe(409);
    // The same currency is still fine, for a new version or a second proposal.
    expect((await call("POST", `/proposals/${first}/versions`, usd)).statusCode).toBeLessThan(300);
    expect((await make("USD")).statusCode).toBe(201);
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

  it("the owner may decide a slot they do not hold, and the audit row says so", async () => {
    const id = await create(terms({}, 18));
    const approval = (await call("POST", `/proposals/${id}/approvals`)).json().data;
    expect(approval.required_approvers).toEqual(["sales_manager"]);
    const res = await decide(approval.id, "sales_manager", "approved", OWNER, "Owner approved");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("approved");
    const [row] = await sql`select after_state from audit_logs where entity_id = ${approval.id} and action = 'approval.approved' order by created_at desc limit 1`;
    expect(row.after_state).toMatchObject({ role: "sales_manager", decided_as_admin: true });
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
    // The queue names the deal and its account.
    expect(mine[0]).toMatchObject({ opportunity_name: expect.any(String), account_name: expect.stringContaining("Approvals Co") });
    const theirs = await call("GET", "/approvals", undefined, OTHER);
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().data).toEqual([]);
    const [any] = await sql`select id from approvals where workspace_id = ${workspaceId} limit 1`;
    expect((await decide(any.id, "executive", "approved", OTHER)).statusCode).toBe(404);
  });
});
