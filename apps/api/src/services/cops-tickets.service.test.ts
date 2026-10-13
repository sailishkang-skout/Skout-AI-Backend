import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import {
  addTicketComment,
  createTicket,
  customerSafeTicket,
  escalateTicket,
  getTicket,
  listTickets,
  loadAccountTickets,
  setCommentVisibility,
  ticketPrefill,
  ticketSummaryInputs,
  transitionTicket,
  updateTicket,
  type TicketContext,
} from "./cops-tickets.service.js";
import { projectCopsEventToTimelineRow } from "./cops-timeline.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-06 engineering tickets against a real Postgres. Acceptance: internal comments never appear
 * in a customer-safe read path (AI summary inputs included); the account link exposes no commercial
 * data; ticket changes update the CRM summary and the timeline.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-06 engineering tickets (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ctx: TicketContext;

  async function account(employees = 50) {
    const [co] = await sql`insert into companies (workspace_id, name, employee_count) values (${ctx.workspaceId}, ${"Tkt " + randomUUID().slice(0, 6)}, ${employees}) returning id`;
    return co.id as string;
  }
  const supportState = async (accountId: string) =>
    (await sql`select state from cops_lifecycle_states where workspace_id = ${ctx.workspaceId} and dimension = 'support' and entity_id = ${accountId}`)[0]?.state as string | undefined;
  const events = async (type: string, ticketId: string) =>
    await sql`select envelope from cops_outbox where event_type = ${type} and aggregate_id = ${ticketId}`;

  beforeAll(async () => {
    const [ws] = await sql`insert into workspaces (name, slug) values ('Ticket ops', ${"tkt-" + randomUUID()}) returning id`;
    const [user] = await sql`insert into users (email) values (${`eng-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    await sql`insert into workspace_members (workspace_id, user_id, role) values (${ws.id}, ${user.id}, 'owner')`;
    ctx = { workspaceId: ws.id, userId: user.id, requestId: randomUUID() };
  });

  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  it("creates a ticket: safe diagnostics only, TicketCreated, CRM summary, support state and timeline", async () => {
    const accountId = await account(2500);
    const { ticket, summary } = await createTicket(db, ctx, {
      account_id: accountId,
      title: "CRM sync fails",
      severity: "high",
      diagnostics: { plan: "trial", access_token: "abc", contract_value: 90000, integrations: [{ key: "crm", status: "error" }] },
    });
    expect(ticket).toMatchObject({ status: "new", severity: "high", account_tier: "enterprise" });
    expect(ticket.diagnostics).toEqual({ plan: "trial", integrations: [{ key: "crm", status: "error" }] });
    expect(summary).toEqual({ open_count: 1, max_severity: "high" });
    expect(await supportState(accountId)).toBe("open_ticket");

    const [created] = await events("TicketCreated", ticket.id);
    expect(created.envelope.payload).toEqual({ ticket_id: ticket.id, account_id: accountId, severity: "high" });
    expect(await projectCopsEventToTimelineRow(db, created.envelope)).toBe(true);
    const [row] = await sql`select type from cops_timeline_events where account_id = ${accountId} and source_event_id = ${created.envelope.event_id}`;
    expect(row.type).toBe("ticket");
    const [hist] = await sql`select from_status, to_status from ticket_status_history where ticket_id = ${ticket.id}`;
    expect(hist).toEqual({ from_status: null, to_status: "new" });
  });

  it("refuses links from another account or workspace", async () => {
    const accountId = await account();
    const other = await account();
    const [contact] = await sql`insert into contacts (workspace_id, company_id, first_name) values (${ctx.workspaceId}, ${other}, 'Zed') returning id`;
    await expect(createTicket(db, ctx, { account_id: accountId, title: "x", contact_id: contact.id })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const [ws2] = await sql`insert into workspaces (name, slug) values ('Other', ${"tkt2-" + randomUUID()}) returning id`;
    await expect(createTicket(db, { ...ctx, workspaceId: ws2.id }, { account_id: accountId, title: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { ticket } = await createTicket(db, ctx, { account_id: accountId, title: "mine" });
    await expect(getTicket(db, { ...ctx, workspaceId: ws2.id }, ticket.id)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("internal notes never reach a customer-safe read path, AI summary inputs included", async () => {
    const accountId = await account();
    const { ticket } = await createTicket(db, ctx, { account_id: accountId, title: "Export broken", repro_steps: "internal repro", log_refs: ["trace-1"] });
    const note = (await addTicketComment(db, ctx, ticket.id, { body: "SECRET root cause: bad deploy", visibility: "internal" }, false)).comment;
    const update = (await addTicketComment(db, ctx, ticket.id, { body: "We are working on a fix", visibility: "customer" }, true)).comment;
    expect(note).toMatchObject({ visibility: "internal", kind: "note" });
    expect(update).toMatchObject({ visibility: "customer", kind: "update" });

    const safe = await customerSafeTicket(db, ctx, ticket.id);
    expect(safe.updates.map((u) => u.body)).toEqual(["We are working on a fix"]);
    expect(JSON.stringify(safe)).not.toMatch(/SECRET|internal repro|trace-1/);
    const inputs = await ticketSummaryInputs(db, ctx, ticket.id, "customer");
    expect(inputs.map((i) => i.id)).toEqual([update.id]);
    expect((await ticketSummaryInputs(db, ctx, ticket.id, "internal")).length).toBe(2);

    // A summary with one internal source stays internal even when customer was asked for, and cannot be published.
    const mixed = (await addTicketComment(db, ctx, ticket.id, { body: "Summary", visibility: "customer", kind: "ai_summary", source_comment_ids: [note.id, update.id] }, true)).comment;
    expect(mixed).toMatchObject({ visibility: "internal", ai_generated: true });
    await expect(setCommentVisibility(db, ctx, ticket.id, mixed.id, { visibility: "customer", reason: "share" }, true)).rejects.toMatchObject({ code: "BUSINESS_STATE_CONFLICT" });
    const clean = (await addTicketComment(db, ctx, ticket.id, { body: "Customer summary", visibility: "customer", kind: "ai_summary", source_comment_ids: [update.id] }, true)).comment;
    expect(clean.visibility).toBe("customer");
    expect((await customerSafeTicket(db, ctx, ticket.id)).updates.map((u) => u.body)).toEqual(["We are working on a fix", "Customer summary"]);
  });

  it("only an approved role publishes; a visibility change is audited with its reason", async () => {
    const accountId = await account();
    const { ticket } = await createTicket(db, ctx, { account_id: accountId, title: "Login loop" });
    await expect(addTicketComment(db, ctx, ticket.id, { body: "Fixed", visibility: "customer" }, false)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    const note = (await addTicketComment(db, ctx, ticket.id, { body: "Fix is rolling out", visibility: "internal" }, false)).comment;
    await expect(setCommentVisibility(db, ctx, ticket.id, note.id, { visibility: "customer", reason: "ok to share" }, false)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const published = await setCommentVisibility(db, ctx, ticket.id, note.id, { visibility: "customer", reason: "ok to share" }, true);
    expect(published.comment.visibility).toBe("customer");
    const [audit] = await sql`select before_state, after_state, reason, is_override from audit_logs where entity_id = ${note.id} and action = 'ticket.comment_visibility_changed'`;
    expect(audit).toMatchObject({ before_state: { visibility: "internal" }, after_state: { visibility: "customer" }, reason: "ok to share", is_override: true });
    // Withdrawing an update needs no publish right and removes it from the customer view.
    await setCommentVisibility(db, ctx, ticket.id, note.id, { visibility: "internal", reason: "sent too early" }, false);
    expect((await customerSafeTicket(db, ctx, ticket.id)).updates).toEqual([]);
  });

  it("follows the state machine; resolving emits TicketResolved and clears the summary", async () => {
    const accountId = await account();
    const { ticket } = await createTicket(db, ctx, { account_id: accountId, title: "Slow search", severity: "critical" });
    await expect(transitionTicket(db, ctx, ticket.id, "resolved")).rejects.toMatchObject({ code: "BUSINESS_STATE_CONFLICT", status: 409 });
    for (const to of ["triage", "assigned", "in_progress", "testing", "waiting_on_customer"] as const) await transitionTicket(db, ctx, ticket.id, to);
    expect((await loadAccountTickets(db, ctx, accountId)).summary).toEqual({ open_count: 1, max_severity: "critical" });

    const resolved = await transitionTicket(db, ctx, ticket.id, "resolved", "Index rebuilt");
    expect(resolved.ticket.resolved_at).not.toBeNull();
    expect(resolved.summary).toEqual({ open_count: 0, max_severity: null });
    expect(await supportState(accountId)).toBe("no_issue");
    expect((await events("TicketResolved", ticket.id)).length).toBe(1);

    await transitionTicket(db, ctx, ticket.id, "verified");
    await transitionTicket(db, ctx, ticket.id, "closed");
    await expect(transitionTicket(db, ctx, ticket.id, "in_progress")).rejects.toMatchObject({ code: "BUSINESS_STATE_CONFLICT" });
    const history = (await getTicket(db, ctx, ticket.id)).history;
    expect(history.map((h) => h.to)).toEqual(["new", "triage", "assigned", "in_progress", "testing", "waiting_on_customer", "resolved", "verified", "closed"]);
    expect(history.find((h) => h.to === "resolved")!.reason).toBe("Index rebuilt");
  });

  it("escalation raises the severity, emits TicketEscalated and updates max severity", async () => {
    const accountId = await account();
    const { ticket } = await createTicket(db, ctx, { account_id: accountId, title: "Sync delay", severity: "medium" });
    await createTicket(db, ctx, { account_id: accountId, title: "Typo", severity: "low" });
    await expect(escalateTicket(db, ctx, ticket.id, { severity: "low", reason: "x" })).rejects.toMatchObject({ code: "BUSINESS_STATE_CONFLICT" });
    const r = await escalateTicket(db, ctx, ticket.id, { severity: "critical", reason: "Customer go-live blocked" });
    expect(r.ticket.escalated_at).not.toBeNull();
    expect(r.summary).toEqual({ open_count: 2, max_severity: "critical" });
    const [ev] = await events("TicketEscalated", ticket.id);
    expect(ev.envelope.payload).toEqual({ ticket_id: ticket.id, account_id: accountId, severity: "critical" });
  });

  it("the account link exposes names only: no commercial or legal data", async () => {
    const accountId = await account();
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${ctx.workspaceId}, 'P') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'Negotiation', 1) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, amount) values (${ctx.workspaceId}, ${accountId}, ${pipeline.id}, ${stage.id}, 'Renewal', 987654) returning id`;
    const { ticket } = await createTicket(db, ctx, { account_id: accountId, opportunity_id: deal.id, title: "API errors" });
    const view = await getTicket(db, ctx, ticket.id);
    expect(view.context.opportunity).toEqual({ id: deal.id, name: "Renewal" });
    expect(JSON.stringify(view)).not.toMatch(/987654|amount|proposal|contract|stage/i);
  });

  it("queue filters, assignment and prefill", async () => {
    const accountId = await account(5000);
    const { ticket } = await createTicket(db, ctx, { account_id: accountId, title: "Queue me", severity: "high", team: "platform" });
    await expect(updateTicket(db, ctx, ticket.id, { assignee_id: randomUUID() })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await updateTicket(db, ctx, ticket.id, { assignee_id: ctx.userId, priority: "p1" });
    const mine = await listTickets(db, ctx, { assignee: "me", tier: "enterprise", severity: "high", team: "platform", open: true, limit: 25 });
    expect(mine.data.map((t) => t.id)).toContain(ticket.id);
    expect((await listTickets(db, ctx, { assignee: "unassigned", account_id: accountId, limit: 25 })).data).toEqual([]);

    const prefill = await ticketPrefill(db, ctx, { account_id: accountId, blocker: "integration_error" });
    expect(prefill).toMatchObject({ account_id: accountId, category: "integration", severity: "high", priority: "p2", environment: "production" });
    expect(prefill.diagnostics).toEqual({ blocker: "integration_error" });
  });
});
