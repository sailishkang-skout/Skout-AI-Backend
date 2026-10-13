import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import {
  appendCopsEvent,
  canTransitionTicket,
  createCopsEvent,
  inheritedTicketVisibility,
  maxTicketSeverity,
  sanitizeTicketDiagnostics,
  ticketSeverityRank,
  TICKET_OPEN_STATUSES,
  type TicketSeverity,
  type TicketStatus,
  type TicketVisibility,
} from "@skout/shared";
import { writeCopsAudit } from "./cops-platform.service.js";
import { runLifecycleTransition } from "./cops-lifecycle.service.js";
import { segmentOf } from "./cops-onboarding-templates.js";
import { loadIntegrations } from "./cops-onboarding-signals.service.js";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-06 additions).
 *   - Tables touched directly: companies, contacts, deals - read (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: a ticket, its links, its CRM summary and its event commit in one transaction with
 *     the account lock; the customer context reads names only, never commercial values.
 *   - Review date: revisit when apps/crm's internal API covers transactional reads
 */

/**
 * COPS-06 engineering tickets (Bible p.51-53, 56-57, 65). Every change runs in one transaction:
 * the ticket, its status history, the audit row, the account's CRM summary (open count, max
 * severity, lifecycle `support` state) and the outbox event. The timeline is fed by the Ticket*
 * events through the COPS-02 projector.
 *
 * Visibility: comments are internal unless published. `customerSafeTicket` and
 * `ticketSummaryInputs(..., "customer")` are the customer-safe read paths and select customer
 * comments only. The customer context exposes names and onboarding state, never commercial or
 * legal data, so the Engineering role cannot reach those through the account link.
 */
const {
  companies,
  contacts,
  deals,
  users,
  workspaceMembers,
  engineeringTickets,
  ticketComments,
  ticketStatusHistory,
  ticketAccountSummaries,
  copsOnboardingInstances,
  copsOnboardingMilestones,
  copsLifecycleStates,
} = schema;

export interface TicketContext {
  workspaceId: string;
  userId: string;
  requestId: string;
}

export class TicketError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "VALIDATION_FAILED" | "BUSINESS_STATE_CONFLICT" | "FORBIDDEN",
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
  get status(): number {
    return { NOT_FOUND: 404, VALIDATION_FAILED: 422, BUSINESS_STATE_CONFLICT: 409, FORBIDDEN: 403 }[this.code];
  }
}

export interface CreateTicketInput {
  account_id: string;
  contact_id?: string;
  opportunity_id?: string;
  milestone_id?: string;
  title: string;
  description?: string;
  category?: string;
  severity?: TicketSeverity;
  priority?: string;
  impact?: string;
  affected_feature?: string;
  environment?: string;
  repro_steps?: string;
  log_refs?: string[];
  diagnostics?: Record<string, unknown>;
  team?: string;
}

type TicketRow = typeof engineeringTickets.$inferSelect;
type CommentRow = typeof ticketComments.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function ticketDto(t: TicketRow) {
  return {
    id: t.id,
    account_id: t.accountId,
    contact_id: t.contactId,
    opportunity_id: t.opportunityId,
    milestone_id: t.milestoneId,
    title: t.title,
    description: t.description,
    category: t.category,
    severity: t.severity,
    priority: t.priority,
    impact: t.impact,
    affected_feature: t.affectedFeature,
    environment: t.environment,
    repro_steps: t.reproSteps,
    log_refs: t.logRefs,
    diagnostics: t.diagnostics,
    status: t.status,
    team: t.team,
    assignee_id: t.assigneeId,
    account_tier: t.accountTier,
    created_by: t.createdBy,
    escalated_at: iso(t.escalatedAt),
    resolved_at: iso(t.resolvedAt),
    closed_at: iso(t.closedAt),
    created_at: iso(t.createdAt),
    updated_at: iso(t.updatedAt),
  };
}

function commentDto(c: CommentRow) {
  return {
    id: c.id,
    visibility: c.visibility as TicketVisibility,
    kind: c.kind,
    body: c.body,
    source_comment_ids: c.sourceCommentIds,
    author_id: c.authorId,
    ai_generated: c.aiGenerated,
    created_at: iso(c.createdAt),
  };
}

const actorOf = (ctx: TicketContext) => ({ type: "user" as const, id: ctx.userId });

/** Locks the account row so concurrent ticket changes on one account rewrite the summary in order. */
async function lockAccount(tx: Db, workspaceId: string, accountId: string) {
  const [account] = await tx
    .select({ id: companies.id, name: companies.name, domain: companies.domain, employeeCount: companies.employeeCount })
    .from(companies)
    .where(and(eq(companies.id, accountId), eq(companies.workspaceId, workspaceId)))
    .for("update")
    .limit(1);
  if (!account) throw new TicketError("NOT_FOUND", "Account not found");
  return account;
}

async function lockTicket(tx: Db, workspaceId: string, ticketId: string) {
  const [ticket] = await tx
    .select()
    .from(engineeringTickets)
    .where(and(eq(engineeringTickets.id, ticketId), eq(engineeringTickets.workspaceId, workspaceId)))
    .for("update")
    .limit(1);
  if (!ticket) throw new TicketError("NOT_FOUND", "Ticket not found");
  return ticket;
}

/**
 * Rewrites the account's CRM summary from its open tickets and moves the lifecycle `support` state
 * between no_issue and open_ticket. An incident-impacted account (COPS-12) is left alone.
 */
async function refreshAccountSummary(tx: Db, ctx: TicketContext, accountId: string) {
  const open = await tx
    .select({ severity: engineeringTickets.severity })
    .from(engineeringTickets)
    .where(
      and(
        eq(engineeringTickets.workspaceId, ctx.workspaceId),
        eq(engineeringTickets.accountId, accountId),
        inArray(engineeringTickets.status, [...TICKET_OPEN_STATUSES])
      )
    );
  const summary = { openCount: open.length, maxSeverity: maxTicketSeverity(open.map((o) => o.severity)), updatedAt: new Date() };
  await tx
    .insert(ticketAccountSummaries)
    .values({ workspaceId: ctx.workspaceId, accountId, ...summary })
    .onConflictDoUpdate({ target: [ticketAccountSummaries.workspaceId, ticketAccountSummaries.accountId], set: summary });

  const [state] = await tx
    .select({ state: copsLifecycleStates.state })
    .from(copsLifecycleStates)
    .where(
      and(
        eq(copsLifecycleStates.workspaceId, ctx.workspaceId),
        eq(copsLifecycleStates.dimension, "support"),
        eq(copsLifecycleStates.entityId, accountId)
      )
    )
    .limit(1);
  const current = state?.state ?? "no_issue";
  const wanted = summary.openCount > 0 ? "open_ticket" : "no_issue";
  if (current !== "incident_impacted" && current !== wanted) {
    await runLifecycleTransition(tx, {
      workspaceId: ctx.workspaceId,
      dimension: "support",
      entityId: accountId,
      to: wanted,
      actorId: ctx.userId,
      source: "api",
      reason: summary.openCount > 0 ? "Engineering ticket opened" : "No open engineering tickets",
      requestId: ctx.requestId,
      occurredAt: summary.updatedAt,
    });
  }
  return { open_count: summary.openCount, max_severity: summary.maxSeverity };
}

/** Linked records must belong to the same workspace, and the contact / milestone to the same account. */
async function checkLinks(tx: Db, workspaceId: string, accountId: string, input: Pick<CreateTicketInput, "contact_id" | "opportunity_id" | "milestone_id">) {
  if (input.contact_id) {
    const [c] = await tx
      .select({ companyId: contacts.companyId })
      .from(contacts)
      .where(and(eq(contacts.id, input.contact_id), eq(contacts.workspaceId, workspaceId)))
      .limit(1);
    if (!c || (c.companyId && c.companyId !== accountId)) throw new TicketError("VALIDATION_FAILED", "Contact does not belong to this account", { field: "contact_id" });
  }
  if (input.opportunity_id) {
    const [d] = await tx
      .select({ companyId: deals.companyId })
      .from(deals)
      .where(and(eq(deals.id, input.opportunity_id), eq(deals.workspaceId, workspaceId)))
      .limit(1);
    if (!d || (d.companyId && d.companyId !== accountId)) throw new TicketError("VALIDATION_FAILED", "Opportunity does not belong to this account", { field: "opportunity_id" });
  }
  if (input.milestone_id) {
    const [m] = await tx
      .select({ accountId: copsOnboardingInstances.accountId })
      .from(copsOnboardingMilestones)
      .innerJoin(copsOnboardingInstances, eq(copsOnboardingInstances.id, copsOnboardingMilestones.instanceId))
      .where(and(eq(copsOnboardingMilestones.id, input.milestone_id), eq(copsOnboardingMilestones.workspaceId, workspaceId)))
      .limit(1);
    if (!m || m.accountId !== accountId) throw new TicketError("VALIDATION_FAILED", "Milestone does not belong to this account", { field: "milestone_id" });
  }
}

/** Safe diagnostics from the account's onboarding context: state and integration status, no secrets. */
async function accountDiagnostics(db: Db, workspaceId: string, accountId: string) {
  const [inst] = await db
    .select({
      customerWorkspaceId: copsOnboardingInstances.customerWorkspaceId,
      activationPct: copsOnboardingInstances.activationPct,
      firstLoginAt: copsOnboardingInstances.firstLoginAt,
    })
    .from(copsOnboardingInstances)
    .where(and(eq(copsOnboardingInstances.workspaceId, workspaceId), eq(copsOnboardingInstances.accountId, accountId)))
    .limit(1);
  if (!inst) return {};
  const integrations = await loadIntegrations(db, inst.customerWorkspaceId);
  return sanitizeTicketDiagnostics({
    customer_workspace_id: inst.customerWorkspaceId,
    activation_pct: inst.activationPct,
    first_login_at: iso(inst.firstLoginAt),
    integrations: integrations.map((i) => ({ key: i.key, status: i.status })),
  });
}

/**
 * Prefill for "Create ticket" from an account or an onboarding blocker: the form opens with
 * category, severity, priority, affected feature, environment, links and safe diagnostics set.
 */
export async function ticketPrefill(db: Db, ctx: TicketContext, input: { account_id: string; milestone_id?: string; blocker?: string }) {
  const [account] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.id, input.account_id), eq(companies.workspaceId, ctx.workspaceId)))
    .limit(1);
  if (!account) throw new TicketError("NOT_FOUND", "Account not found");

  let milestone: { id: string; key: string; label: string } | null = null;
  if (input.milestone_id) {
    await checkLinks(db, ctx.workspaceId, account.id, { milestone_id: input.milestone_id });
    const [m] = await db
      .select({ id: copsOnboardingMilestones.id, key: copsOnboardingMilestones.key, label: copsOnboardingMilestones.label })
      .from(copsOnboardingMilestones)
      .where(eq(copsOnboardingMilestones.id, input.milestone_id))
      .limit(1);
    milestone = m ?? null;
  }
  const [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, ctx.workspaceId), eq(contacts.companyId, account.id)))
    .orderBy(asc(contacts.createdAt))
    .limit(1);

  const diagnostics = await accountDiagnostics(db, ctx.workspaceId, account.id);
  const integrationError = input.blocker === "integration_error" || milestone?.key === "crm_connected";
  const blocked = Boolean(input.blocker || milestone);
  const subject = milestone ? `${milestone.label} blocked` : input.blocker ? input.blocker.replace(/_/g, " ") : "Issue";
  return {
    account_id: account.id,
    contact_id: contact?.id ?? null,
    milestone_id: milestone?.id ?? null,
    title: `${account.name}: ${subject}`,
    category: integrationError ? "integration" : "bug",
    // An onboarding blocker stops activation, so it starts high; the reporter can lower it.
    severity: blocked ? "high" : "medium",
    priority: blocked ? "p2" : "p3",
    impact: blocked ? "Onboarding is blocked for this account" : null,
    affected_feature: integrationError ? "CRM integration" : (milestone?.label ?? null),
    environment: "production",
    diagnostics: sanitizeTicketDiagnostics({ ...diagnostics, ...(input.blocker ? { blocker: input.blocker } : {}) }),
  };
}

export async function createTicket(db: Db, ctx: TicketContext, input: CreateTicketInput) {
  return db.transaction(async (tx) => {
    const account = await lockAccount(tx as never, ctx.workspaceId, input.account_id);
    await checkLinks(tx as never, ctx.workspaceId, account.id, input);
    const [ticket] = await tx
      .insert(engineeringTickets)
      .values({
        workspaceId: ctx.workspaceId,
        accountId: account.id,
        contactId: input.contact_id ?? null,
        opportunityId: input.opportunity_id ?? null,
        milestoneId: input.milestone_id ?? null,
        title: input.title,
        description: input.description ?? null,
        category: input.category ?? "bug",
        severity: input.severity ?? "medium",
        priority: input.priority ?? "p3",
        impact: input.impact ?? null,
        affectedFeature: input.affected_feature ?? null,
        environment: input.environment ?? "production",
        reproSteps: input.repro_steps ?? null,
        logRefs: input.log_refs ?? [],
        diagnostics: sanitizeTicketDiagnostics(input.diagnostics),
        team: input.team ?? null,
        accountTier: segmentOf(account.employeeCount),
        createdBy: ctx.userId,
      })
      .returning();
    if (!ticket) throw new Error("Ticket insert returned no row");

    await tx.insert(ticketStatusHistory).values({ workspaceId: ctx.workspaceId, ticketId: ticket.id, fromStatus: null, toStatus: "new", actorId: ctx.userId });
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: actorOf(ctx),
      entityType: "engineering_ticket",
      entityId: ticket.id,
      action: "ticket.created",
      after: { status: "new", severity: ticket.severity, account_id: account.id },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    await appendCopsEvent(
      tx as never,
      createCopsEvent({
        eventType: "TicketCreated",
        tenantId: ctx.workspaceId,
        aggregateType: "ticket",
        aggregateId: ticket.id,
        actor: actorOf(ctx),
        correlationId: ctx.requestId,
        payload: { ticket_id: ticket.id, account_id: account.id, severity: ticket.severity },
      })
    );
    const summary = await refreshAccountSummary(tx as never, ctx, account.id);
    return { ticket: ticketDto(ticket), summary };
  });
}

export interface TicketQueueFilters {
  severity?: string;
  status?: string;
  assignee?: string;
  tier?: string;
  team?: string;
  account_id?: string;
  open?: boolean;
  cursor?: number;
  limit: number;
}

/** Engineering queue: newest first within severity, filtered by severity, status, assignee, team and account tier. */
export async function listTickets(db: Db, ctx: TicketContext, f: TicketQueueFilters) {
  const where = [eq(engineeringTickets.workspaceId, ctx.workspaceId)];
  if (f.severity) where.push(eq(engineeringTickets.severity, f.severity));
  if (f.status) where.push(eq(engineeringTickets.status, f.status));
  if (f.open) where.push(inArray(engineeringTickets.status, [...TICKET_OPEN_STATUSES]));
  if (f.tier) where.push(eq(engineeringTickets.accountTier, f.tier));
  if (f.team) where.push(eq(engineeringTickets.team, f.team));
  if (f.account_id) where.push(eq(engineeringTickets.accountId, f.account_id));
  if (f.assignee === "unassigned") where.push(sql`${engineeringTickets.assigneeId} is null`);
  else if (f.assignee) where.push(eq(engineeringTickets.assigneeId, f.assignee === "me" ? ctx.userId : f.assignee));

  const offset = f.cursor ?? 0;
  const rows = await db
    .select({ ticket: engineeringTickets, accountName: companies.name, assigneeEmail: users.email })
    .from(engineeringTickets)
    .innerJoin(companies, eq(companies.id, engineeringTickets.accountId))
    .leftJoin(users, eq(users.id, engineeringTickets.assigneeId))
    .where(and(...where))
    .orderBy(
      sql`case ${engineeringTickets.severity} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`,
      desc(engineeringTickets.createdAt),
      desc(engineeringTickets.id)
    )
    .limit(f.limit + 1)
    .offset(offset);
  return {
    data: rows.slice(0, f.limit).map((r) => ({ ...ticketDto(r.ticket), account_name: r.accountName, assignee_email: r.assigneeEmail })),
    next_cursor: rows.length > f.limit ? offset + f.limit : null,
  };
}

async function loadTicket(db: Db, workspaceId: string, ticketId: string) {
  const [ticket] = await db
    .select()
    .from(engineeringTickets)
    .where(and(eq(engineeringTickets.id, ticketId), eq(engineeringTickets.workspaceId, workspaceId)))
    .limit(1);
  if (!ticket) throw new TicketError("NOT_FOUND", "Ticket not found");
  return ticket;
}

async function loadComments(db: Db, workspaceId: string, ticketId: string, customerOnly: boolean) {
  return db
    .select()
    .from(ticketComments)
    .where(
      and(
        eq(ticketComments.workspaceId, workspaceId),
        eq(ticketComments.ticketId, ticketId),
        ...(customerOnly ? [eq(ticketComments.visibility, "customer")] : [])
      )
    )
    .orderBy(asc(ticketComments.createdAt), asc(ticketComments.id));
}

export async function loadAccountSummary(db: Db, workspaceId: string, accountId: string) {
  const [s] = await db
    .select({ openCount: ticketAccountSummaries.openCount, maxSeverity: ticketAccountSummaries.maxSeverity })
    .from(ticketAccountSummaries)
    .where(and(eq(ticketAccountSummaries.workspaceId, workspaceId), eq(ticketAccountSummaries.accountId, accountId)))
    .limit(1);
  return { open_count: s?.openCount ?? 0, max_severity: s?.maxSeverity ?? null };
}

/**
 * Customer context for the ticket drawer. Names, tier and onboarding state only: no deal value,
 * stage, proposal, contract or payment. This is what keeps commercial and legal data out of reach
 * of a role that only holds tickets:read.
 */
async function customerContext(db: Db, ticket: TicketRow) {
  const [account] = await db
    .select({ id: companies.id, name: companies.name, domain: companies.domain })
    .from(companies)
    .where(and(eq(companies.id, ticket.accountId), eq(companies.workspaceId, ticket.workspaceId)))
    .limit(1);
  const [contact] = ticket.contactId
    ? await db
        .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.id, ticket.contactId), eq(contacts.workspaceId, ticket.workspaceId)))
        .limit(1)
    : [];
  const [opportunity] = ticket.opportunityId
    ? await db
        .select({ id: deals.id, name: deals.name })
        .from(deals)
        .where(and(eq(deals.id, ticket.opportunityId), eq(deals.workspaceId, ticket.workspaceId)))
        .limit(1)
    : [];
  const [milestone] = ticket.milestoneId
    ? await db
        .select({ id: copsOnboardingMilestones.id, label: copsOnboardingMilestones.label, completedAt: copsOnboardingMilestones.completedAt })
        .from(copsOnboardingMilestones)
        .where(and(eq(copsOnboardingMilestones.id, ticket.milestoneId), eq(copsOnboardingMilestones.workspaceId, ticket.workspaceId)))
        .limit(1)
    : [];
  return {
    account: account ? { id: account.id, name: account.name, domain: account.domain, tier: ticket.accountTier } : null,
    contact: contact ? { id: contact.id, name: [contact.firstName, contact.lastName].filter(Boolean).join(" "), email: contact.email } : null,
    opportunity: opportunity ? { id: opportunity.id, name: opportunity.name } : null,
    milestone: milestone ? { id: milestone.id, label: milestone.label, completed_at: iso(milestone.completedAt) } : null,
    summary: await loadAccountSummary(db, ticket.workspaceId, ticket.accountId),
  };
}

/** Internal view for the ticket drawer: every comment, the history and the customer context. */
export async function getTicket(db: Db, ctx: TicketContext, ticketId: string) {
  const ticket = await loadTicket(db, ctx.workspaceId, ticketId);
  const [comments, history, context] = await Promise.all([
    loadComments(db, ctx.workspaceId, ticketId, false),
    db
      .select()
      .from(ticketStatusHistory)
      .where(and(eq(ticketStatusHistory.workspaceId, ctx.workspaceId), eq(ticketStatusHistory.ticketId, ticketId)))
      .orderBy(asc(ticketStatusHistory.createdAt), asc(ticketStatusHistory.id)),
    customerContext(db, ticket),
  ]);
  return {
    ...ticketDto(ticket),
    context,
    comments: comments.map(commentDto),
    history: history.map((h) => ({ from: h.fromStatus, to: h.toStatus, actor_id: h.actorId, reason: h.reason, at: iso(h.createdAt) })),
  };
}

/**
 * Customer-safe read path: what may be shown to the customer. Customer comments only, and no
 * internal fields (repro steps, log refs, diagnostics, assignee, team).
 */
export async function customerSafeTicket(db: Db, ctx: TicketContext, ticketId: string) {
  const ticket = await loadTicket(db, ctx.workspaceId, ticketId);
  const comments = await loadComments(db, ctx.workspaceId, ticketId, true);
  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    severity: ticket.severity,
    affected_feature: ticket.affectedFeature,
    created_at: iso(ticket.createdAt),
    resolved_at: iso(ticket.resolvedAt),
    updates: comments.map((c) => ({ id: c.id, body: c.body, created_at: iso(c.createdAt) })),
  };
}

/**
 * The only source of comment text for an AI summary. A summary for the customer is built from
 * customer comments alone; an internal summary may read everything and is stored internal.
 */
export async function ticketSummaryInputs(db: Db, ctx: TicketContext, ticketId: string, audience: TicketVisibility) {
  await loadTicket(db, ctx.workspaceId, ticketId);
  const comments = await loadComments(db, ctx.workspaceId, ticketId, audience === "customer");
  return comments.filter((c) => c.kind !== "ai_summary").map((c) => ({ id: c.id, visibility: c.visibility as TicketVisibility, body: c.body }));
}

export async function transitionTicket(db: Db, ctx: TicketContext, ticketId: string, to: TicketStatus, reason?: string) {
  return db.transaction(async (tx) => {
    const ticket = await lockTicket(tx as never, ctx.workspaceId, ticketId);
    const from = ticket.status as TicketStatus;
    if (!canTransitionTicket(from, to)) {
      throw new TicketError("BUSINESS_STATE_CONFLICT", `A ticket cannot move from ${from} to ${to}`, { from, to });
    }
    await lockAccount(tx as never, ctx.workspaceId, ticket.accountId);
    const now = new Date();
    const [updated] = await tx
      .update(engineeringTickets)
      .set({
        status: to,
        updatedAt: now,
        ...(to === "resolved" ? { resolvedAt: now } : {}),
        ...(to === "in_progress" && from !== "assigned" ? { resolvedAt: null } : {}),
        ...(to === "closed" ? { closedAt: now } : {}),
      })
      .where(eq(engineeringTickets.id, ticket.id))
      .returning();
    await tx.insert(ticketStatusHistory).values({ workspaceId: ctx.workspaceId, ticketId: ticket.id, fromStatus: from, toStatus: to, actorId: ctx.userId, reason: reason ?? null });
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: actorOf(ctx),
      entityType: "engineering_ticket",
      entityId: ticket.id,
      action: "ticket.status_changed",
      before: { status: from },
      after: { status: to },
      reason,
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    if (to === "resolved") {
      await appendCopsEvent(
        tx as never,
        createCopsEvent({
          eventType: "TicketResolved",
          tenantId: ctx.workspaceId,
          aggregateType: "ticket",
          aggregateId: ticket.id,
          actor: actorOf(ctx),
          correlationId: ctx.requestId,
          payload: { ticket_id: ticket.id, account_id: ticket.accountId },
        })
      );
    }
    const summary = await refreshAccountSummary(tx as never, ctx, ticket.accountId);
    return { ticket: ticketDto(updated!), summary };
  });
}

/** Escalation raises the severity (never lowers it), needs a reason and emits TicketEscalated. */
export async function escalateTicket(db: Db, ctx: TicketContext, ticketId: string, input: { severity: TicketSeverity; reason: string }) {
  return db.transaction(async (tx) => {
    const ticket = await lockTicket(tx as never, ctx.workspaceId, ticketId);
    if (!TICKET_OPEN_STATUSES.includes(ticket.status as TicketStatus)) {
      throw new TicketError("BUSINESS_STATE_CONFLICT", "Only an open ticket can be escalated", { status: ticket.status });
    }
    if (ticketSeverityRank(input.severity) <= ticketSeverityRank(ticket.severity)) {
      throw new TicketError("BUSINESS_STATE_CONFLICT", "Escalation must raise the severity", { from: ticket.severity, to: input.severity });
    }
    await lockAccount(tx as never, ctx.workspaceId, ticket.accountId);
    const now = new Date();
    const [updated] = await tx
      .update(engineeringTickets)
      .set({ severity: input.severity, escalatedAt: now, updatedAt: now })
      .where(eq(engineeringTickets.id, ticket.id))
      .returning();
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: actorOf(ctx),
      entityType: "engineering_ticket",
      entityId: ticket.id,
      action: "ticket.escalated",
      before: { severity: ticket.severity },
      after: { severity: input.severity },
      reason: input.reason,
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    await appendCopsEvent(
      tx as never,
      createCopsEvent({
        eventType: "TicketEscalated",
        tenantId: ctx.workspaceId,
        aggregateType: "ticket",
        aggregateId: ticket.id,
        actor: actorOf(ctx),
        correlationId: ctx.requestId,
        payload: { ticket_id: ticket.id, account_id: ticket.accountId, severity: input.severity },
      })
    );
    const summary = await refreshAccountSummary(tx as never, ctx, ticket.accountId);
    return { ticket: ticketDto(updated!), summary };
  });
}

/** Assignment and triage fields. The assignee must be a member of the workspace. */
export async function updateTicket(db: Db, ctx: TicketContext, ticketId: string, input: { assignee_id?: string | null; team?: string | null; priority?: string }) {
  return db.transaction(async (tx) => {
    const ticket = await lockTicket(tx as never, ctx.workspaceId, ticketId);
    if (input.assignee_id) {
      const [member] = await tx
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, input.assignee_id)))
        .limit(1);
      if (!member) throw new TicketError("VALIDATION_FAILED", "Assignee is not a member of this workspace", { field: "assignee_id" });
    }
    const set = {
      ...(input.assignee_id !== undefined ? { assigneeId: input.assignee_id } : {}),
      ...(input.team !== undefined ? { team: input.team } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    };
    const [updated] = await tx
      .update(engineeringTickets)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(engineeringTickets.id, ticket.id))
      .returning();
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: actorOf(ctx),
      entityType: "engineering_ticket",
      entityId: ticket.id,
      action: "ticket.updated",
      before: { assignee_id: ticket.assigneeId, team: ticket.team, priority: ticket.priority },
      after: { assignee_id: updated!.assigneeId, team: updated!.team, priority: updated!.priority },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return { ticket: ticketDto(updated!) };
  });
}

export interface AddCommentInput {
  body: string;
  visibility: TicketVisibility;
  kind?: "note" | "update" | "ai_summary";
  source_comment_ids?: string[];
}

/**
 * Adds an internal note or a customer update. A customer-visible comment needs `canPublish` (the
 * caller holds tickets:send). An AI summary takes the visibility of its sources: one internal
 * source keeps it internal whatever was asked for.
 */
export async function addTicketComment(db: Db, ctx: TicketContext, ticketId: string, input: AddCommentInput, canPublish: boolean) {
  return db.transaction(async (tx) => {
    const ticket = await lockTicket(tx as never, ctx.workspaceId, ticketId);
    const kind = input.kind ?? (input.visibility === "customer" ? "update" : "note");
    let visibility = input.visibility;
    const sourceIds = kind === "ai_summary" ? [...new Set(input.source_comment_ids ?? [])] : [];
    if (kind === "ai_summary") {
      const sources = sourceIds.length
        ? await tx
            .select({ id: ticketComments.id, visibility: ticketComments.visibility })
            .from(ticketComments)
            .where(and(eq(ticketComments.workspaceId, ctx.workspaceId), eq(ticketComments.ticketId, ticket.id), inArray(ticketComments.id, sourceIds)))
        : [];
      if (sources.length !== sourceIds.length) throw new TicketError("VALIDATION_FAILED", "A summary source is not a comment on this ticket", { field: "source_comment_ids" });
      if (inheritedTicketVisibility(sources.map((s) => s.visibility)) === "internal") visibility = "internal";
    }
    if (visibility === "customer" && !canPublish) {
      throw new TicketError("FORBIDDEN", "You do not have permission to publish customer-facing updates", { required_permission: "tickets:send" });
    }
    const [comment] = await tx
      .insert(ticketComments)
      .values({
        workspaceId: ctx.workspaceId,
        ticketId: ticket.id,
        visibility,
        kind,
        body: input.body,
        sourceCommentIds: sourceIds,
        authorId: ctx.userId,
        aiGenerated: kind === "ai_summary",
      })
      .returning();
    await tx.update(engineeringTickets).set({ updatedAt: new Date() }).where(eq(engineeringTickets.id, ticket.id));
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: actorOf(ctx),
      entityType: "ticket_comment",
      entityId: comment!.id,
      action: visibility === "customer" ? "ticket.customer_update_published" : "ticket.internal_note_added",
      after: { ticket_id: ticket.id, visibility, kind },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return { comment: commentDto(comment!) };
  });
}

/**
 * Changes a comment's visibility. Always audited with a reason. Publishing needs `canPublish`, and
 * an AI summary built from an internal source can never be published.
 */
export async function setCommentVisibility(
  db: Db,
  ctx: TicketContext,
  ticketId: string,
  commentId: string,
  input: { visibility: TicketVisibility; reason: string },
  canPublish: boolean
) {
  return db.transaction(async (tx) => {
    const [comment] = await tx
      .select()
      .from(ticketComments)
      .where(and(eq(ticketComments.id, commentId), eq(ticketComments.ticketId, ticketId), eq(ticketComments.workspaceId, ctx.workspaceId)))
      .for("update")
      .limit(1);
    if (!comment) throw new TicketError("NOT_FOUND", "Comment not found");
    if (comment.visibility === input.visibility) return { comment: commentDto(comment) };
    if (input.visibility === "customer") {
      if (!canPublish) throw new TicketError("FORBIDDEN", "You do not have permission to publish customer-facing updates", { required_permission: "tickets:send" });
      if (comment.kind === "ai_summary") {
        const sources = comment.sourceCommentIds.length
          ? await tx
              .select({ visibility: ticketComments.visibility })
              .from(ticketComments)
              .where(and(eq(ticketComments.workspaceId, ctx.workspaceId), inArray(ticketComments.id, comment.sourceCommentIds)))
          : [];
        if (sources.length !== comment.sourceCommentIds.length || inheritedTicketVisibility(sources.map((s) => s.visibility)) === "internal") {
          throw new TicketError("BUSINESS_STATE_CONFLICT", "A summary built from internal notes cannot be published");
        }
      }
    }
    const [updated] = await tx
      .update(ticketComments)
      .set({ visibility: input.visibility, updatedAt: new Date() })
      .where(eq(ticketComments.id, comment.id))
      .returning();
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: actorOf(ctx),
      entityType: "ticket_comment",
      entityId: comment.id,
      action: "ticket.comment_visibility_changed",
      before: { visibility: comment.visibility },
      after: { visibility: input.visibility },
      reason: input.reason,
      override: true,
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return { comment: commentDto(updated!) };
  });
}

/** Account Engineering tab on Customer 360: the CRM summary and the account's tickets, open first. */
export async function loadAccountTickets(db: Db, ctx: TicketContext, accountId: string) {
  const [account] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.id, accountId), eq(companies.workspaceId, ctx.workspaceId)))
    .limit(1);
  if (!account) throw new TicketError("NOT_FOUND", "Account not found");
  const [summary, tickets] = await Promise.all([
    loadAccountSummary(db, ctx.workspaceId, accountId),
    listTickets(db, ctx, { account_id: accountId, limit: 50 }),
  ]);
  return { summary, tickets: tickets.data };
}
