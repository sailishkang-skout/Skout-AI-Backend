import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { createTicket, type TicketContext } from "./cops-tickets.service.js";
import { getIncidentDetail, linkTicketToIncident, publishIncidentCustomerUpdate, unlinkTicketFromIncident, updateIncident } from "./cops-incidents.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-12 incidents against real Postgres. Acceptance: linked tickets share one investigation
 * owner; customer-safe incident updates reach every linked ticket; a ticket has one incident.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-12 incident linking (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ctx: TicketContext;
  let ownerA: string;
  let ownerB: string;
  const accounts: string[] = [];

  beforeAll(async () => {
    const [ws] = await sql`insert into workspaces (name, slug) values ('Incident ops', ${"inc-" + randomUUID()}) returning id`;
    const mk = async (label: string) => {
      const [u] = await sql`insert into users (email) values (${`${label}-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
      await sql`insert into workspace_members (workspace_id, user_id, role) values (${ws.id}, ${u.id}, 'owner')`;
      return u.id as string;
    };
    const me = await mk("me");
    ownerA = await mk("owner-a");
    ownerB = await mk("owner-b");
    ctx = { workspaceId: ws.id, userId: me, requestId: randomUUID() };
    for (const n of ["Acme", "Beta"]) {
      const [co] = await sql`insert into companies (workspace_id, name) values (${ws.id}, ${n}) returning id`;
      accounts.push(co.id);
    }
  });
  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  async function incident(ownerId: string | null) {
    const [row] = await sql`insert into incidents (workspace_id, title, source, severity, owner_id) values (${ctx.workspaceId}, 'Sync outage', 'manual', 'high', ${ownerId}) returning id`;
    return row.id as string;
  }

  it("linked tickets share one investigation owner, also after the owner changes", async () => {
    const inc = await incident(ownerA);
    const t1 = (await createTicket(db, ctx, { account_id: accounts[0], title: "Sync fails A" } as never)).ticket;
    const t2 = (await createTicket(db, ctx, { account_id: accounts[1], title: "Sync fails B" } as never)).ticket;
    await linkTicketToIncident(db, ctx, inc, t1.id);
    await linkTicketToIncident(db, ctx, inc, t2.id);
    let detail = await getIncidentDetail(db, ctx.workspaceId, inc);
    expect(detail.tickets.map((t) => t.assignee_id)).toEqual([ownerA, ownerA]);
    expect(detail.affected_accounts.map((a) => a.name).sort()).toEqual(["Acme", "Beta"]);

    detail = await updateIncident(db, ctx, inc, { owner_id: ownerB, workaround: "Re-run the sync manually", root_cause: "Token refresh race", follow_ups: [{ text: "Add a retry", done: false }] });
    expect(detail.tickets.every((t) => t.assignee_id === ownerB)).toBe(true);
    expect(detail).toMatchObject({ workaround: "Re-run the sync manually", root_cause: "Token refresh race", follow_ups: [{ text: "Add a retry", done: false }] });
    const audit = await sql`select action from audit_logs where entity_id = ${inc} order by created_at`;
    expect(audit.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(["incident.ticket_linked", "incident.updated"]));
  });

  it("a ticket belongs to at most one incident; unlink frees it", async () => {
    const a = await incident(null);
    const b = await incident(null);
    const t = (await createTicket(db, ctx, { account_id: accounts[0], title: "One home" } as never)).ticket;
    await linkTicketToIncident(db, ctx, a, t.id);
    await linkTicketToIncident(db, ctx, a, t.id); // linking again to the same incident is a no-op
    await expect(linkTicketToIncident(db, ctx, b, t.id)).rejects.toMatchObject({ code: "TICKET_ALREADY_LINKED", status: 409 });
    await unlinkTicketFromIncident(db, ctx, a, t.id);
    await linkTicketToIncident(db, ctx, b, t.id);
    expect((await getIncidentDetail(db, ctx.workspaceId, b)).tickets).toHaveLength(1);
  });

  it("a customer-safe update reaches every linked ticket as a customer comment, and needs tickets:send", async () => {
    const inc = await incident(ownerA);
    const t1 = (await createTicket(db, ctx, { account_id: accounts[0], title: "Down A" } as never)).ticket;
    const t2 = (await createTicket(db, ctx, { account_id: accounts[1], title: "Down B" } as never)).ticket;
    await linkTicketToIncident(db, ctx, inc, t1.id);
    await linkTicketToIncident(db, ctx, inc, t2.id);
    await expect(publishIncidentCustomerUpdate(db, ctx, inc, "We found the cause", false)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const r = await publishIncidentCustomerUpdate(db, ctx, inc, "We found the cause and a fix is rolling out", true);
    expect(r.ticketsUpdated).toBe(2);
    const comments = await sql`select ticket_id, visibility, body from ticket_comments where ticket_id in (${t1.id}, ${t2.id})`;
    expect(comments).toHaveLength(2);
    expect(comments.every((c: { visibility: string }) => c.visibility === "customer")).toBe(true);
    // The update is a response for each ticket's SLA.
    const clocks = await sql`select met_at from sla_clocks where ticket_id in (${t1.id}, ${t2.id}) and kind = 'response'`;
    expect(clocks.every((c: { met_at: Date | null }) => c.met_at !== null)).toBe(true);
    expect((await getIncidentDetail(db, ctx.workspaceId, inc)).customer_update).toBe("We found the cause and a fix is rolling out");
  });
});
