/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-12 additions).
 *   - Tables touched directly: companies (read the names of the affected accounts)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: an incident lists the customers its linked tickets come from.
 *   - Review date: 2026-10-21
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { writeCopsAudit } from "./cops-platform.service.js";
import { addTicketComment, TicketError, updateTicket, type TicketContext } from "./cops-tickets.service.js";

/**
 * COPS-12 incident linking (Bible p.54). Many customer tickets can be symptoms of one incident:
 *   - a ticket links to at most one incident (unique index);
 *   - linking assigns the ticket to the incident owner, and changing the owner reassigns every
 *     linked ticket, so the tickets share one investigation owner;
 *   - a customer-safe incident update is posted as a customer-visible comment on every linked
 *     ticket (each customer keeps their own thread); internal detail stays on the incident.
 * Affected customers are the accounts of the linked tickets.
 */
const { incidents, incidentTicketLinks, engineeringTickets, companies } = schema;
type IncidentRow = typeof incidents.$inferSelect;

export interface IncidentPatch {
  title?: string;
  severity?: "low" | "medium" | "high" | "critical";
  status?: "open" | "investigating" | "resolved";
  owner_id?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  workaround?: string | null;
  root_cause?: string | null;
  follow_ups?: { text: string; done: boolean }[];
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
function incidentDto(i: IncidentRow) {
  return {
    id: i.id,
    title: i.title,
    severity: i.severity,
    status: i.status,
    source: i.source,
    description: i.description,
    owner_id: i.ownerId,
    started_at: iso(i.startedAt ?? i.detectedAt),
    ended_at: iso(i.endedAt ?? i.resolvedAt),
    workaround: i.workaround,
    root_cause: i.rootCause,
    follow_ups: i.followUps,
    customer_update: i.customerUpdate,
    customer_update_at: iso(i.customerUpdateAt),
    detected_at: iso(i.detectedAt),
    resolved_at: iso(i.resolvedAt),
  };
}

async function loadIncident(db: Db, workspaceId: string, incidentId: string) {
  const [row] = await db.select().from(incidents).where(and(eq(incidents.id, incidentId), eq(incidents.workspaceId, workspaceId))).limit(1);
  if (!row) throw new TicketError("NOT_FOUND", "Incident not found");
  return row;
}

async function linkedTickets(db: Db, workspaceId: string, incidentId: string) {
  return db
    .select({ id: engineeringTickets.id, title: engineeringTickets.title, status: engineeringTickets.status, severity: engineeringTickets.severity, assigneeId: engineeringTickets.assigneeId, accountId: engineeringTickets.accountId, accountName: companies.name })
    .from(incidentTicketLinks)
    .innerJoin(engineeringTickets, eq(engineeringTickets.id, incidentTicketLinks.ticketId))
    .innerJoin(companies, eq(companies.id, engineeringTickets.accountId))
    .where(and(eq(incidentTicketLinks.workspaceId, workspaceId), eq(incidentTicketLinks.incidentId, incidentId)))
    .orderBy(asc(incidentTicketLinks.createdAt));
}

export async function getIncidentDetail(db: Db, workspaceId: string, incidentId: string) {
  const incident = await loadIncident(db, workspaceId, incidentId);
  const tickets = await linkedTickets(db, workspaceId, incidentId);
  const accounts = new Map(tickets.map((t) => [t.accountId, t.accountName]));
  return {
    ...incidentDto(incident),
    tickets: tickets.map((t) => ({ id: t.id, title: t.title, status: t.status, severity: t.severity, assignee_id: t.assigneeId, account_id: t.accountId, account_name: t.accountName })),
    affected_accounts: [...accounts].map(([id, name]) => ({ id, name })),
  };
}

/** Linked ticket counts and affected account counts for a list of incidents. */
export async function incidentLinkCounts(db: Db, workspaceId: string, incidentIds: string[]) {
  if (!incidentIds.length) return new Map<string, { tickets: number; accounts: number }>();
  const rows = await db
    .select({ incidentId: incidentTicketLinks.incidentId, accountId: engineeringTickets.accountId })
    .from(incidentTicketLinks)
    .innerJoin(engineeringTickets, eq(engineeringTickets.id, incidentTicketLinks.ticketId))
    .where(and(eq(incidentTicketLinks.workspaceId, workspaceId), inArray(incidentTicketLinks.incidentId, incidentIds)));
  const out = new Map<string, { tickets: number; accounts: Set<string> }>();
  for (const r of rows) {
    const e = out.get(r.incidentId) ?? { tickets: 0, accounts: new Set<string>() };
    e.tickets++;
    e.accounts.add(r.accountId);
    out.set(r.incidentId, e);
  }
  return new Map([...out].map(([k, v]) => [k, { tickets: v.tickets, accounts: v.accounts.size }]));
}

export async function updateIncident(db: Db, ctx: TicketContext, incidentId: string, patch: IncidentPatch) {
  const before = await loadIncident(db, ctx.workspaceId, incidentId);
  const now = new Date();
  const [after] = await db
    .update(incidents)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
      ...(patch.status !== undefined ? { status: patch.status, ...(patch.status === "resolved" && !before.resolvedAt ? { resolvedAt: now, resolvedBy: ctx.userId } : {}) } : {}),
      ...(patch.owner_id !== undefined ? { ownerId: patch.owner_id } : {}),
      ...(patch.started_at !== undefined ? { startedAt: patch.started_at ? new Date(patch.started_at) : null } : {}),
      ...(patch.ended_at !== undefined ? { endedAt: patch.ended_at ? new Date(patch.ended_at) : null } : {}),
      ...(patch.workaround !== undefined ? { workaround: patch.workaround } : {}),
      ...(patch.root_cause !== undefined ? { rootCause: patch.root_cause } : {}),
      ...(patch.follow_ups !== undefined ? { followUps: patch.follow_ups } : {}),
      updatedAt: now,
    })
    .where(eq(incidents.id, before.id))
    .returning();
  await writeCopsAudit(db, {
    tenantId: ctx.workspaceId,
    actor: { type: "user", id: ctx.userId },
    entityType: "incident",
    entityId: before.id,
    action: "incident.updated",
    before: incidentDto(before),
    after: incidentDto(after!),
    correlationId: ctx.requestId,
    sourceChannel: "api",
  });
  // One investigation owner: a new owner takes every linked ticket.
  if (patch.owner_id !== undefined && patch.owner_id && patch.owner_id !== before.ownerId) {
    for (const t of await linkedTickets(db, ctx.workspaceId, before.id)) {
      if (t.assigneeId !== patch.owner_id) await updateTicket(db, ctx, t.id, { assignee_id: patch.owner_id });
    }
  }
  return getIncidentDetail(db, ctx.workspaceId, before.id);
}

export async function linkTicketToIncident(db: Db, ctx: TicketContext, incidentId: string, ticketId: string) {
  const incident = await loadIncident(db, ctx.workspaceId, incidentId);
  const [ticket] = await db.select({ id: engineeringTickets.id, assigneeId: engineeringTickets.assigneeId }).from(engineeringTickets).where(and(eq(engineeringTickets.id, ticketId), eq(engineeringTickets.workspaceId, ctx.workspaceId))).limit(1);
  if (!ticket) throw new TicketError("NOT_FOUND", "Ticket not found");
  const [existing] = await db.select({ incidentId: incidentTicketLinks.incidentId }).from(incidentTicketLinks).where(eq(incidentTicketLinks.ticketId, ticketId)).limit(1);
  if (existing && existing.incidentId !== incident.id) throw new TicketError("TICKET_ALREADY_LINKED", "The ticket is linked to another incident", { incident_id: existing.incidentId });
  if (!existing) {
    const inserted = await db.insert(incidentTicketLinks).values({ workspaceId: ctx.workspaceId, incidentId: incident.id, ticketId, createdBy: ctx.userId }).onConflictDoNothing().returning({ id: incidentTicketLinks.id });
    if (!inserted.length) throw new TicketError("TICKET_ALREADY_LINKED", "The ticket is linked to another incident");
    await writeCopsAudit(db, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "incident",
      entityId: incident.id,
      action: "incident.ticket_linked",
      after: { ticket_id: ticketId },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
  }
  if (incident.ownerId && ticket.assigneeId !== incident.ownerId) await updateTicket(db, ctx, ticketId, { assignee_id: incident.ownerId });
  return { incident_id: incident.id, ticket_id: ticketId };
}

export async function unlinkTicketFromIncident(db: Db, ctx: TicketContext, incidentId: string, ticketId: string) {
  await loadIncident(db, ctx.workspaceId, incidentId);
  const removed = await db
    .delete(incidentTicketLinks)
    .where(and(eq(incidentTicketLinks.workspaceId, ctx.workspaceId), eq(incidentTicketLinks.incidentId, incidentId), eq(incidentTicketLinks.ticketId, ticketId)))
    .returning({ id: incidentTicketLinks.id });
  if (!removed.length) throw new TicketError("NOT_FOUND", "The ticket is not linked to this incident");
  await writeCopsAudit(db, {
    tenantId: ctx.workspaceId,
    actor: { type: "user", id: ctx.userId },
    entityType: "incident",
    entityId: incidentId,
    action: "incident.ticket_unlinked",
    before: { ticket_id: ticketId },
    correlationId: ctx.requestId,
    sourceChannel: "api",
  });
}

/**
 * Publishes a customer-safe update: recorded on the incident and posted as a customer-visible
 * comment on every linked ticket. The caller holds tickets:send.
 */
export async function publishIncidentCustomerUpdate(db: Db, ctx: TicketContext, incidentId: string, body: string, canPublish: boolean) {
  if (!canPublish) throw new TicketError("FORBIDDEN", "Publishing a customer update needs tickets:send");
  const incident = await loadIncident(db, ctx.workspaceId, incidentId);
  const now = new Date();
  await db.update(incidents).set({ customerUpdate: body, customerUpdateAt: now, updatedAt: now }).where(eq(incidents.id, incident.id));
  const tickets = await linkedTickets(db, ctx.workspaceId, incident.id);
  for (const t of tickets) {
    if (t.status === "closed") continue;
    await addTicketComment(db, ctx, t.id, { body, visibility: "customer" } as never, true);
  }
  await writeCopsAudit(db, {
    tenantId: ctx.workspaceId,
    actor: { type: "user", id: ctx.userId },
    entityType: "incident",
    entityId: incident.id,
    action: "incident.customer_update_published",
    after: { tickets: tickets.length },
    correlationId: ctx.requestId,
    sourceChannel: "api",
  });
  return { ticketsUpdated: tickets.filter((t) => t.status !== "closed").length };
}
