import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { approveRecommendation, dismissRecommendation, generateRecommendations, listRecommendations, type RationaleModel, type RecContext } from "./cops-recommendations.service.js";
import { installSuccessPlaybooks } from "./cops-playbooks.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-13 recommendations against real Postgres, including the red-team acceptance: internal ticket
 * notes and other workspaces' data never reach the model, a model answer citing evidence it was not
 * given is refused, and every recommendation links evidence. Nothing runs before approval.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const INTERNAL_CANARY = `CANARY-INTERNAL-${randomUUID()}`;
const OTHER_TENANT_CANARY = `CANARY-OTHER-${randomUUID()}`;
const ALL = ["crm:read", "crm:write", "commercial:read", "commercial:write", "billing:read", "onboarding:read", "tickets:read"];

maybe("COPS-13 recommendations (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  const now = new Date();
  const days = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
  let ctx: RecContext;
  let accountId: string;
  let otherTicketId: string;
  let otherWs: string;
  const prompts: string[] = [];

  /** A model that cites the first evidence id it was given, and records every prompt. */
  const citingModel: RationaleModel = async (messages) => {
    const text = messages.map((m) => m.content).join("\n");
    prompts.push(text);
    const id = /id=([0-9a-f-]{36})/.exec(text)?.[1];
    return JSON.stringify({ rationale: "Grounded rationale written from the evidence given to the model.", evidence_ids: id ? [id] : [] });
  };

  beforeAll(async () => {
    const [ws] = await sql`insert into workspaces (name, slug) values ('Rec ops', ${"rec-" + randomUUID()}) returning id`;
    const [user] = await sql`insert into users (email) values (${`rec-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    await sql`insert into workspace_members (workspace_id, user_id, role) values (${ws.id}, ${user.id}, 'owner')`;
    ctx = { workspaceId: ws.id, userId: user.id, requestId: randomUUID(), permissions: ALL };
    const [p] = await sql`insert into pipelines (workspace_id, name) values (${ws.id}, 'Default') returning id`;
    const [st] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${p.id}, 'Q', 0) returning id`;
    const [co] = await sql`insert into companies (workspace_id, name, employee_count, owner_id, health_score, health_state) values (${ws.id}, 'Rec Co', 50, ${user.id}, 25, 'at_risk') returning id`;
    accountId = co.id;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, amount, currency) values (${ws.id}, ${co.id}, ${p.id}, ${st.id}, 'D', 100, 'INR') returning id`;
    const [sub] = await sql`insert into subscriptions (workspace_id, account_id, opportunity_id, status, billing, currency, cadence, term_months, term_start, term_end)
      values (${ws.id}, ${co.id}, ${deal.id}, 'active', 'invoiced', 'INR', 'monthly', 12, ${days(-330)}, ${days(30)}) returning id`;
    await sql`insert into subscription_items (workspace_id, subscription_id, kind, quantity, unit_amount_minor) values (${ws.id}, ${sub.id}, 'seats', 5, 100000)`;
    const [t] = await sql`insert into engineering_tickets (workspace_id, account_id, title, priority, severity, status) values (${ws.id}, ${co.id}, 'Checkout down', 'p1', 'critical', 'in_progress') returning id`;
    await sql`insert into sla_clocks (workspace_id, ticket_id, kind, calendar, target_minutes, started_at, breached_at) values (${ws.id}, ${t.id}, 'resolution', '24x7', 240, ${days(-1)}, ${days(-0.5)})`;
    await sql`insert into ticket_comments (workspace_id, ticket_id, visibility, kind, body) values (${ws.id}, ${t.id}, 'internal', 'note', ${"Root cause is our bad deploy " + INTERNAL_CANARY})`;
    await sql`insert into ticket_comments (workspace_id, ticket_id, visibility, kind, body) values (${ws.id}, ${t.id}, 'customer', 'update', 'We are rolling out a fix today.')`;

    // Another workspace with its own at-risk account and ticket. None of it may reach the model.
    const [w2] = await sql`insert into workspaces (name, slug) values ('Rec other', ${"rec2-" + randomUUID()}) returning id`;
    otherWs = w2.id;
    const [co2] = await sql`insert into companies (workspace_id, name, health_score, health_state) values (${w2.id}, ${OTHER_TENANT_CANARY}, 10, 'at_risk') returning id`;
    const [t2] = await sql`insert into engineering_tickets (workspace_id, account_id, title, priority, severity, status) values (${w2.id}, ${co2.id}, ${OTHER_TENANT_CANARY}, 'p1', 'critical', 'new') returning id`;
    otherTicketId = t2.id;
  });
  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  it("generates evidence-linked recommendations; internal notes and other workspaces never reach the model", async () => {
    const r = await generateRecommendations(db, ctx, accountId, citingModel, new Date(now));
    const types = r.data.map((x) => x.type).sort();
    expect(types).toEqual(["renewal_risk", "sla_breached"]);
    // 5 seats × INR 1,000 a month = INR 60,000 a year, read from the subscription's own items.
    const renewal = r.data.find((x) => x.type === "renewal_risk")!;
    expect(renewal.evidence_refs[0]!.label).toContain("INR 60,000 ARR");
    for (const rec of r.data) {
      expect(rec.status).toBe("pending");
      expect(rec.evidence_refs.length).toBeGreaterThan(0);
      expect(rec.source).toBe("llm");
      expect(rec.confidence).toBeGreaterThan(0);
      const [ev] = await sql`select count(*)::int as n from evidence_ledger where id = ${rec.evidence_id} and workspace_id = ${ctx.workspaceId}`;
      expect(ev.n).toBe(1);
    }
    const all = prompts.join("\n");
    expect(all).toContain("We are rolling out a fix today.");
    expect(all).not.toContain(INTERNAL_CANARY);
    expect(all).not.toContain("bad deploy");
    expect(all).not.toContain(OTHER_TENANT_CANARY);
    for (const rec of r.data) expect(JSON.stringify(rec)).not.toContain(INTERNAL_CANARY);
    // The prompt itself is not stored, only its hash.
    const [row] = await sql`select input_hash from next_best_action_suggestions where id = ${r.data[0]!.id}`;
    expect(row.input_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("regenerating adds nothing while a recommendation is pending", async () => {
    const r = await generateRecommendations(db, ctx, accountId, citingModel, new Date(now));
    expect(r.generated).toBe(0);
    expect(r.data).toHaveLength(2);
  });

  it("a model answer citing evidence it was not given (another workspace's ticket) is refused; the rule's wording is used", async () => {
    await sql`update next_best_action_suggestions set status = 'dismissed' where workspace_id = ${ctx.workspaceId}`;
    const leaky: RationaleModel = async () => JSON.stringify({ rationale: `Look at ${OTHER_TENANT_CANARY}, it is the same incident as this one.`, evidence_ids: [otherTicketId] });
    const r = await generateRecommendations(db, ctx, accountId, leaky, new Date(now));
    expect(r.generated).toBe(2);
    for (const rec of r.data) {
      expect(rec.source).toBe("rules");
      expect(rec.rationale).not.toContain(OTHER_TENANT_CANARY);
      expect(rec.evidence_refs.every((e) => e.id !== otherTicketId)).toBe(true);
    }
    // Without a model the rule's wording is used too.
    await sql`update next_best_action_suggestions set status = 'dismissed' where workspace_id = ${ctx.workspaceId}`;
    const none = await generateRecommendations(db, ctx, accountId, null, new Date(now));
    expect(none.data.every((x) => x.source === "rules" && x.evidence_refs.length > 0)).toBe(true);
  });

  it("retrieval obeys the role: without commercial:read the renewal recommendation is neither built nor shown", async () => {
    const eng: RecContext = { ...ctx, permissions: ["crm:read", "crm:write", "tickets:read"] };
    prompts.length = 0;
    await sql`update next_best_action_suggestions set status = 'dismissed' where workspace_id = ${ctx.workspaceId}`;
    const r = await generateRecommendations(db, eng, accountId, citingModel, new Date(now));
    expect(r.data.map((x) => x.type)).toEqual(["sla_breached"]);
    expect(prompts.join("\n")).not.toContain("ARR");
    await generateRecommendations(db, ctx, accountId, citingModel, new Date(now));
    expect((await listRecommendations(db, eng, accountId, "pending")).map((x) => x.type)).toEqual(["sla_breached"]);
    expect((await listRecommendations(db, ctx, accountId, "pending")).map((x) => x.type).sort()).toEqual(["renewal_risk", "sla_breached"]);
  });

  it("approve runs the one action, once, with an audit row and a timeline entry; another workspace cannot touch it", async () => {
    const [sla] = await listRecommendations(db, ctx, accountId, "pending").then((l) => l.filter((x) => x.type === "sla_breached"));
    await expect(approveRecommendation(db, { ...ctx, workspaceId: otherWs }, sla!.id, undefined)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(approveRecommendation(db, { ...ctx, permissions: ["crm:read"] }, sla!.id, undefined)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const { data } = await approveRecommendation(db, ctx, sla!.id, "Doing it now");
    expect(data).toMatchObject({ status: "approved", decided_by: ctx.userId, decision_reason: "Doing it now", effect: { kind: "task" } });
    const taskId = (data.effect as { id: string }).id;
    const [task] = await sql`select title, priority, related_entity_id from tasks where id = ${taskId}`;
    expect(task).toMatchObject({ priority: "high", related_entity_id: accountId });
    const [ev] = await sql`select count(*)::int as n from cops_outbox where tenant_id = ${ctx.workspaceId} and event_type = 'TaskCreated' and envelope->'payload'->>'task_id' = ${taskId}`;
    expect(ev.n).toBe(1);
    const [audit] = await sql`select count(*)::int as n from audit_logs where workspace_id = ${ctx.workspaceId} and action = 'recommendation.approved' and entity_id = ${accountId}`;
    expect(audit.n).toBe(1);
    const [act] = await sql`select count(*)::int as n from activities where workspace_id = ${ctx.workspaceId} and entity_id = ${accountId} and subject like 'Recommendation approved:%'`;
    expect(act.n).toBe(1);
    await expect(approveRecommendation(db, ctx, sla!.id, undefined)).rejects.toMatchObject({ code: "BUSINESS_STATE_CONFLICT" });
  });

  it("a playbook action starts the installed playbook; without one it creates the playbook's task", async () => {
    const [renewal] = (await listRecommendations(db, ctx, accountId, "pending")).filter((x) => x.type === "renewal_risk");
    await expect(approveRecommendation(db, { ...ctx, permissions: ["crm:read", "crm:write", "commercial:read"] }, renewal!.id, undefined)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const first = await approveRecommendation(db, ctx, renewal!.id, undefined);
    expect(first.data.effect).toMatchObject({ kind: "task", fallback: "playbook_not_installed" });
    expect(first.runToEnqueue).toBeNull();

    await installSuccessPlaybooks(db, ctx.workspaceId, ctx.userId);
    await sql`update next_best_action_suggestions set status = 'dismissed' where workspace_id = ${ctx.workspaceId} and status = 'pending'`;
    await generateRecommendations(db, ctx, accountId, null, new Date(now));
    const [again] = (await listRecommendations(db, ctx, accountId, "pending")).filter((x) => x.type === "renewal_risk");
    const second = await approveRecommendation(db, ctx, again!.id, undefined);
    expect(second.data.effect).toMatchObject({ kind: "workflow_run" });
    expect(second.runToEnqueue).toBe((second.data.effect as { id: string }).id);
    const [run] = await sql`select subject_type, subject_id, trigger_type from automation_runs where id = ${second.runToEnqueue}`;
    expect(run).toMatchObject({ subject_type: "account", subject_id: accountId, trigger_type: "manual" });
  });

  it("reads usage, the timeline and running playbooks: low credits are recommended, a stale touch is evidence, a running playbook is not suggested again", async () => {
    // The renewal playbook started by the previous test is still running on the account.
    await sql`update next_best_action_suggestions set status = 'dismissed' where workspace_id = ${ctx.workspaceId} and status = 'pending'`;
    const [cust] = await sql`insert into workspaces (name, slug) values ('Rec customer', ${"recc-" + randomUUID()}) returning id`;
    const [deal] = await sql`select id from deals where company_id = ${accountId} limit 1`;
    await sql`insert into cops_provisionings (workspace_id, account_id, opportunity_id, idempotency_key, status, request, provisioned_workspace_id)
      values (${ctx.workspaceId}, ${accountId}, ${deal.id}, ${randomUUID()}, 'succeeded', ${sql.json({ credits: 1000 })}, ${cust.id})`;
    await sql`insert into cops_onboarding_instances (workspace_id, account_id, template_id, template_key, template_version, activated_at)
      select ${ctx.workspaceId}, ${accountId}, id, key, version, ${days(-20)} from cops_activation_templates where workspace_id is null limit 1`;
    await sql`insert into credit_balances (workspace_id, balance) values (${cust.id}, 80)`;
    await sql`insert into credit_transactions (workspace_id, amount, kind, action, created_at) values (${cust.id}, -400, 'consume', 'search', ${days(-40)})`;
    await sql`insert into credit_transactions (workspace_id, amount, kind, action, created_at) values (${cust.id}, -500, 'consume', 'search', ${days(-3)})`;
    const [last] = await sql`insert into credit_transactions (workspace_id, amount, kind, action, created_at) values (${cust.id}, -20, 'consume', 'search', ${days(-1)}) returning id`;
    const [touch] = await sql`insert into cops_timeline_events (workspace_id, account_id, type, occurred_at, actor_type, source_event_id, event_type, summary)
      values (${ctx.workspaceId}, ${accountId}, 'call', ${days(-45)}, 'user', ${randomUUID()}, 'ActivityRecorded', 'Check-in call') returning id`;

    await generateRecommendations(db, ctx, accountId, null, new Date(now));
    const recs = await listRecommendations(db, ctx, accountId, "pending");
    const credits = recs.find((r) => r.type === "credits_running_low");
    expect(credits?.evidence_refs).toEqual([{ kind: "credit_ledger", id: last.id, label: "520 credits used in 30 days; 80 of 1,000 left" }]);
    expect(recs.some((r) => r.type === "renewal_risk")).toBe(false);

    await sql`update automation_runs set status = 'succeeded' where workspace_id = ${ctx.workspaceId} and subject_id = ${accountId}`;
    await generateRecommendations(db, ctx, accountId, null, new Date(now));
    const renewal = (await listRecommendations(db, ctx, accountId, "pending")).find((r) => r.type === "renewal_risk");
    expect(renewal?.evidence_refs).toContainEqual({ kind: "timeline_event", id: touch.id, label: `Last call 45 days ago (${days(-45).slice(0, 10)})` });
  });

  it("dismiss needs a reason and is audited", async () => {
    const [rec] = await listRecommendations(db, ctx, accountId, "pending");
    await expect(dismissRecommendation(db, ctx, rec!.id, " ")).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    const d = await dismissRecommendation(db, ctx, rec!.id, "Customer already booked a call");
    expect(d).toMatchObject({ status: "dismissed", decision_reason: "Customer already booked a call" });
    const [audit] = await sql`select count(*)::int as n from audit_logs where workspace_id = ${ctx.workspaceId} and action = 'recommendation.dismissed'`;
    expect(audit.n).toBeGreaterThanOrEqual(1);
    await expect(dismissRecommendation(db, ctx, rec!.id, "again")).rejects.toMatchObject({ code: "BUSINESS_STATE_CONFLICT" });
  });
});
