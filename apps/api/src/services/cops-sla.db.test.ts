import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { addTicketComment, createTicket, recordTicketRelease, transitionTicket, updateTicket, type TicketContext } from "./cops-tickets.service.js";
import { backfillSlaClocks, getTicketSla } from "./cops-sla.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-12 SLA clocks against real Postgres: every ticket is tracked from creation; the response
 * clock stops on the first response; waiting on customer pauses; resolved meets; a reopen needs a
 * reason and resumes; Verified needs verification evidence.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-12 ticket SLA (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ctx: TicketContext;
  let accountId: string;

  beforeAll(async () => {
    const [ws] = await sql`insert into workspaces (name, slug) values ('SLA ops', ${"sla-" + randomUUID()}) returning id`;
    const [user] = await sql`insert into users (email) values (${`sla-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    await sql`insert into workspace_members (workspace_id, user_id, role) values (${ws.id}, ${user.id}, 'owner')`;
    ctx = { workspaceId: ws.id, userId: user.id, requestId: randomUUID() };
    const [co] = await sql`insert into companies (workspace_id, name, employee_count) values (${ws.id}, 'SLA Co', 50) returning id`;
    accountId = co.id;
  });
  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  const clocks = async (ticketId: string) => {
    const t = { id: ticketId, priority: "", accountTier: "", status: "" };
    const [row] = await sql`select priority, account_tier, status from engineering_tickets where id = ${ticketId}`;
    return (await getTicketSla(db, ctx.workspaceId, { ...t, priority: row.priority, accountTier: row.account_tier, status: row.status })).clocks;
  };
  const byKind = async (ticketId: string, kind: string) => (await clocks(ticketId)).find((c) => c.kind === kind)!;

  it("every ticket gets a response and a resolution clock; P1 runs 24x7 with the Bible targets", async () => {
    const { ticket } = await createTicket(db, ctx, { account_id: accountId, title: "Outage", priority: "p1", severity: "critical" } as never);
    const c = await clocks(ticket.id);
    expect(c.map((x) => x.kind).sort()).toEqual(["resolution", "response"]);
    expect(await byKind(ticket.id, "response")).toMatchObject({ target_minutes: 15, calendar: "24x7", state: "running" });
    expect(await byKind(ticket.id, "resolution")).toMatchObject({ target_minutes: 240, calendar: "24x7" });
    const due = new Date((await byKind(ticket.id, "response")).due_at!).getTime() - new Date((await byKind(ticket.id, "response")).started_at).getTime();
    expect(due).toBe(15 * 60_000);
  });

  it("100% of P1/P2 tickets have tracked SLA, and backfill covers tickets that predate COPS-12", async () => {
    const [old] = await sql`insert into engineering_tickets (workspace_id, account_id, title, priority, status) values (${ctx.workspaceId}, ${accountId}, 'Old P2', 'p2', 'assigned') returning id`;
    expect(await backfillSlaClocks(db, ctx.workspaceId)).toBeGreaterThanOrEqual(1);
    const [untracked] = await sql`select count(*)::int as n from engineering_tickets t where t.workspace_id = ${ctx.workspaceId} and t.priority in ('p1','p2')
      and t.status not in ('resolved','verified','closed') and not exists (select 1 from sla_clocks c where c.ticket_id = t.id)`;
    expect(untracked.n).toBe(0);
    expect((await byKind(old.id, "response")).target_minutes).toBe(60);
  });

  it("the first move out of triage or the first customer update meets the response clock", async () => {
    const a = (await createTicket(db, ctx, { account_id: accountId, title: "A", priority: "p2" } as never)).ticket;
    await transitionTicket(db, ctx, a.id, "triage");
    expect((await byKind(a.id, "response")).met_at).toBeNull();
    await transitionTicket(db, ctx, a.id, "assigned");
    expect((await byKind(a.id, "response")).state).toBe("met");
    const [r] = await sql`select first_response_at from engineering_tickets where id = ${a.id}`;
    expect(r.first_response_at).not.toBeNull();

    const b = (await createTicket(db, ctx, { account_id: accountId, title: "B", priority: "p2" } as never)).ticket;
    await addTicketComment(db, ctx, b.id, { body: "We are looking at it", visibility: "customer" } as never, true);
    expect((await byKind(b.id, "response")).state).toBe("met");
  });

  it("waiting on customer pauses both open clocks and leaving it resumes them", async () => {
    const t = (await createTicket(db, ctx, { account_id: accountId, title: "Pause", priority: "p1" } as never)).ticket;
    await transitionTicket(db, ctx, t.id, "triage");
    await transitionTicket(db, ctx, t.id, "waiting_on_customer");
    const paused = await byKind(t.id, "resolution");
    expect(paused).toMatchObject({ paused: true, due_at: null, state: "paused" });
    await transitionTicket(db, ctx, t.id, "in_progress");
    expect(await byKind(t.id, "resolution")).toMatchObject({ paused: false, state: "running" });
  });

  it("resolved meets the resolution clock; Verified needs evidence; a reopen needs a reason and resumes the clock", async () => {
    const t = (await createTicket(db, ctx, { account_id: accountId, title: "Fix", priority: "p3" } as never)).ticket;
    for (const s of ["triage", "assigned", "in_progress", "testing", "resolved"] as const) await transitionTicket(db, ctx, t.id, s);
    expect((await byKind(t.id, "resolution")).state).toBe("met");

    await expect(transitionTicket(db, ctx, t.id, "verified")).rejects.toMatchObject({ code: "VERIFICATION_REQUIRED", status: 422, details: { missing: ["qa_verification", "customer_verification"] } });
    await expect(transitionTicket(db, ctx, t.id, "in_progress")).rejects.toMatchObject({ code: "REASON_REQUIRED", status: 422 });

    await expect(recordTicketRelease(db, ctx, t.id, { qa_evidence: "  " })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const rel = await recordTicketRelease(db, ctx, t.id, { release_id: "rel-2026-10-21", fixed_in_version: "1.4.2", deployed_at: "2026-10-21T10:00:00Z", qa_evidence: "Regression green" });
    expect(rel).toMatchObject({ release_id: "rel-2026-10-21", fixed_in_version: "1.4.2", qa_evidence: "Regression green", customer_verified_at: null });
    await expect(transitionTicket(db, ctx, t.id, "verified")).rejects.toMatchObject({ details: { missing: ["customer_verification"] } });
    await recordTicketRelease(db, ctx, t.id, { customer_evidence: "Customer confirmed" });
    await transitionTicket(db, ctx, t.id, "verified");
    // A reopen clears the verification but keeps the history.
        await transitionTicket(db, ctx, t.id, "in_progress", "Customer still sees the error");
    expect(await byKind(t.id, "resolution")).toMatchObject({ met_at: null, state: "running" });
    const [row] = await sql`select reopen_count from engineering_tickets where id = ${t.id}`;
    expect(row.reopen_count).toBe(1);
    const [ver] = await sql`select qa_verified_at, customer_verified_at, qa_evidence from engineering_tickets where id = ${t.id}`;
    expect(ver).toMatchObject({ qa_verified_at: null, customer_verified_at: null, qa_evidence: "Regression green" });
    const history = await sql`select reason from ticket_status_history where ticket_id = ${t.id} and from_status = 'verified'`;
    expect(history[0].reason).toBe("Customer still sees the error");
  });

  it("a priority change re-targets the running clocks and keeps the time used", async () => {
    const t = (await createTicket(db, ctx, { account_id: accountId, title: "Retarget", priority: "p4" } as never)).ticket;
    expect((await byKind(t.id, "resolution")).target_minutes).toBe(2700);
    await updateTicket(db, ctx, t.id, { priority: "p1" });
    expect(await byKind(t.id, "resolution")).toMatchObject({ target_minutes: 240, calendar: "24x7" });
  });
});
