import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { assignBillingTicket, createBillingTicket, listBillingTickets, resolveBillingTicket } from "./cops-billing-tickets.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

/** A customer asks for a refund or cancel: CS raises it, Finance does it and closes it. */
maybe("billing tickets (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ws: string, cs: string, finance: string, account: string, otherAccount: string, paid: string, unpaid: string, sub: string;
  const ctx = (userId: string) => ({ workspaceId: ws, userId, requestId: randomUUID() });

  beforeAll(async () => {
    [{ id: ws }] = await sql`insert into workspaces (name, slug) values ('Billing tickets (test)', ${"bt-" + randomUUID()}) returning id`;
    const member = async (role: string, opsRole: string) => {
      const [u] = await sql`insert into users (email) values (${`bt-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
      await sql`insert into workspace_members (workspace_id, user_id, role) values (${ws}, ${u.id}, ${role})`;
      await sql`insert into workspace_member_roles (workspace_id, user_id, role_id) select ${ws}, ${u.id}, id from roles where key = ${opsRole} and workspace_id is null`;
      return u.id as string;
    };
    cs = await member("member", "cs");
    finance = await member("member", "finance");
    [{ id: account }] = await sql`insert into companies (workspace_id, name) values (${ws}, 'Refund Co') returning id`;
    [{ id: otherAccount }] = await sql`insert into companies (workspace_id, name) values (${ws}, 'Other Co') returning id`;
    const [p] = await sql`insert into pipelines (workspace_id, name) values (${ws}, 'Sales') returning id`;
    const [s] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${p.id}, 'Won', 1) returning id`;
    const [d] = await sql`insert into deals (workspace_id, pipeline_id, stage_id, name, company_id) values (${ws}, ${p.id}, ${s.id}, 'Deal', ${account}) returning id`;
    const pr = async (status: string) =>
      (await sql`insert into payment_requests (workspace_id, opportunity_id, amount_minor, currency, provider, provider_ref, checkout_url, status) values (${ws}, ${d.id}, 599900, 'INR', 'razorpay', ${"plink_" + randomUUID().slice(0, 8)}, 'https://rzp.io/x', ${status}) returning id`)[0].id as string;
    paid = await pr("paid");
    unpaid = await pr("requested");
    [{ id: sub }] = await sql`insert into subscriptions (workspace_id, account_id, opportunity_id, billing, currency, cadence, term_months, term_start, term_end) values (${ws}, ${account}, ${d.id}, 'payment_link', 'INR', 'monthly', 12, now(), now() + interval '1 year') returning id`;
  });
  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  it("raises a refund, refuses a second one and an unpaid or foreign payment", async () => {
    const t = await createBillingTicket(db, ctx(cs), { accountId: account, kind: "refund", paymentRequestId: paid, reason: "Customer was charged twice" });
    expect(t).toMatchObject({ status: "open", kind: "refund", account_name: "Refund Co", payment: { amount_minor: 599900, currency: "INR", status: "paid" } });
    expect(t.raised_by?.id).toBe(cs);
    await expect(createBillingTicket(db, ctx(cs), { accountId: account, kind: "refund", paymentRequestId: paid, reason: "Again please" })).rejects.toThrow(/already an open billing ticket/);
    await expect(createBillingTicket(db, ctx(cs), { accountId: account, kind: "refund", paymentRequestId: unpaid, reason: "Not paid yet" })).rejects.toThrow(/Only a paid payment/);
    await expect(createBillingTicket(db, ctx(cs), { accountId: otherAccount, kind: "refund", paymentRequestId: paid, reason: "Wrong customer" })).rejects.toThrow(/not on this customer/);
    const timeline = await sql`select subject from activities where entity_id = ${account} and activity_type = 'billing_ticket'`;
    expect(timeline.map((r: { subject: string }) => r.subject)).toContain("Billing ticket raised: Refund INR 5,999");
  });

  it("assigns only to Finance and closes as done only after the refund happened", async () => {
    const [t] = await listBillingTickets(db, ws, { status: "active", accountId: account });
    await expect(assignBillingTicket(db, ctx(finance), t!.id, cs)).rejects.toThrow(/someone in Finance/);
    const assigned = await assignBillingTicket(db, ctx(finance), t!.id, finance);
    expect(assigned).toMatchObject({ status: "in_progress", assignee: { id: finance } });
    await expect(resolveBillingTicket(db, ctx(finance), t!.id, { outcome: "done" })).rejects.toThrow(/Refund the payment first/);
    await sql`update payment_requests set status = 'refunded' where id = ${paid}`;
    const done = await resolveBillingTicket(db, ctx(finance), t!.id, { outcome: "done", note: "Refunded in full" });
    expect(done).toMatchObject({ status: "done", resolution_note: "Refunded in full", resolved_by: { id: finance } });
    await expect(resolveBillingTicket(db, ctx(finance), t!.id, { outcome: "declined", note: "x" })).rejects.toThrow(/already done/);
  });

  it("a cancel request needs the subscription cancelled to be done; declining needs a note", async () => {
    const t = await createBillingTicket(db, ctx(cs), { accountId: account, kind: "cancel", subscriptionId: sub, reason: "Moving to another tool" });
    await expect(resolveBillingTicket(db, ctx(finance), t.id, { outcome: "done" })).rejects.toThrow(/Cancel the subscription first/);
    await expect(resolveBillingTicket(db, ctx(finance), t.id, { outcome: "declined" })).rejects.toThrow(/Say why/);
    const declined = await resolveBillingTicket(db, ctx(finance), t.id, { outcome: "declined", note: "Customer stayed after a discount" });
    expect(declined.status).toBe("declined");
    const audit = await sql`select action from audit_logs where workspace_id = ${ws} and entity_type = 'billing_ticket' order by created_at`;
    expect(audit.map((r: { action: string }) => r.action)).toEqual(expect.arrayContaining(["billing_ticket.raised", "billing_ticket.assigned", "billing_ticket.done", "billing_ticket.declined"]));
  });
});
