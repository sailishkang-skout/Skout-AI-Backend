import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import {
  DEFAULT_SLA_POLICY,
  SLA_CLOCK_KINDS,
  TICKET_OPEN_STATUSES,
  resolveSlaTarget,
  slaClockStatus,
  slaDueAt,
  slaMeet,
  slaPause,
  slaPolicySchema,
  slaResume,
  slaUsedMinutes,
  type SlaCalendarKind,
  type SlaClockKind,
  type SlaClockState,
  type SlaPolicy,
} from "@skout/shared";
import { getConfig } from "./cops-admin-config.service.js";

/**
 * COPS-12 SLA clocks (Bible p.52). Every ticket gets a response and a resolution clock when it is
 * created, so 100% of P1/P2 tickets are tracked. The ticket lifecycle drives them:
 *   - response is met by the first move out of new/triage or the first customer-visible comment;
 *   - a pause status (waiting_on_customer by default) stops both clocks, leaving it resumes them;
 *   - resolved meets the resolution clock, a reopen resumes it, closed stops whatever still runs;
 *   - a priority change re-targets the clocks from the policy, keeping the time already used.
 * Every function takes the caller's transaction so a clock change commits with the ticket change.
 */
const { slaClocks, engineeringTickets } = schema;
type Tx = Db;
type ClockRow = typeof slaClocks.$inferSelect;
type TicketLike = { id: string; priority: string; accountTier: string; status: string };

export interface LoadedSlaPolicy {
  policy: SlaPolicy;
  version: number;
}

export async function loadSlaPolicy(db: Db, workspaceId: string): Promise<LoadedSlaPolicy> {
  const config = await getConfig(db, workspaceId, "sla_policy", "default");
  const parsed = slaPolicySchema.safeParse(config?.value);
  return parsed.success ? { policy: parsed.data, version: config?.version ?? 0 } : { policy: DEFAULT_SLA_POLICY, version: 0 };
}

const toState = (r: ClockRow): SlaClockState => ({
  kind: r.kind as SlaClockKind,
  targetMinutes: r.targetMinutes,
  calendar: r.calendar as SlaCalendarKind,
  usedMinutes: r.usedMinutes,
  runningSince: r.runningSince,
  metAt: r.metAt,
  breachedAt: r.breachedAt,
});

async function saveClock(tx: Tx, row: ClockRow, next: SlaClockState, policy: SlaPolicy, now: Date) {
  await tx
    .update(slaClocks)
    .set({
      targetMinutes: next.targetMinutes,
      calendar: next.calendar,
      usedMinutes: next.usedMinutes,
      runningSince: next.runningSince,
      metAt: next.metAt,
      breachedAt: next.breachedAt,
      dueAt: slaDueAt(next, policy.calendar),
      updatedAt: now,
    })
    .where(eq(slaClocks.id, row.id));
}

/** Creates the two clocks of a new ticket (no-op when they exist). */
export async function startSlaClocks(tx: Tx, workspaceId: string, ticket: TicketLike, now = new Date()) {
  const { policy, version } = await loadSlaPolicy(tx, workspaceId);
  const target = resolveSlaTarget(policy, ticket.priority, ticket.accountTier);
  const paused = policy.pauseStatuses.includes(ticket.status);
  for (const kind of SLA_CLOCK_KINDS) {
    const state: SlaClockState = {
      kind,
      targetMinutes: kind === "response" ? target.response : target.resolution,
      calendar: target.calendar,
      usedMinutes: 0,
      runningSince: paused ? null : now,
      metAt: null,
      breachedAt: null,
    };
    await tx
      .insert(slaClocks)
      .values({
        workspaceId,
        ticketId: ticket.id,
        kind,
        calendar: state.calendar,
        targetMinutes: state.targetMinutes,
        startedAt: now,
        runningSince: state.runningSince,
        dueAt: slaDueAt(state, policy.calendar),
        policyVersion: version,
      })
      .onConflictDoNothing();
  }
}

async function clocksOf(tx: Tx, workspaceId: string, ticketId: string) {
  return tx.select().from(slaClocks).where(and(eq(slaClocks.workspaceId, workspaceId), eq(slaClocks.ticketId, ticketId))).for("update");
}

const RESPONSE_STATUSES = ["new", "triage"];

/** Applies a status change to the clocks. Returns true when this change is the first response. */
export async function onTicketStatusChange(tx: Tx, workspaceId: string, ticket: TicketLike, from: string, to: string, now = new Date()) {
  const { policy } = await loadSlaPolicy(tx, workspaceId);
  const clocks = await clocksOf(tx, workspaceId, ticket.id);
  const pausing = policy.pauseStatuses.includes(to);
  const resuming = policy.pauseStatuses.includes(from) && !pausing;
  const reopen = (from === "resolved" || from === "verified" || from === "closed") && to === "in_progress";
  let firstResponse = false;
  for (const row of clocks) {
    let c = toState(row);
    if (row.kind === "response" && !c.metAt && !RESPONSE_STATUSES.includes(to)) {
      c = slaMeet(c, now, policy.calendar);
      firstResponse = true;
    }
    if (row.kind === "resolution") {
      if (to === "resolved" || to === "closed") c = slaMeet(c, now, policy.calendar);
      else if (reopen) c = { ...c, metAt: null, runningSince: now };
    }
    if (to === "closed" && !c.metAt) c = slaMeet(c, now, policy.calendar);
    if (pausing) c = slaPause(c, now, policy.calendar);
    else if (resuming) c = slaResume(c, now);
    await saveClock(tx, row, c, policy, now);
  }
  return firstResponse;
}

/** A customer-visible comment is a response. Returns true when it is the first one. */
export async function onCustomerComment(tx: Tx, workspaceId: string, ticketId: string, now = new Date()) {
  const { policy } = await loadSlaPolicy(tx, workspaceId);
  const [row] = (await clocksOf(tx, workspaceId, ticketId)).filter((r) => r.kind === "response");
  if (!row || row.metAt) return false;
  await saveClock(tx, row, slaMeet(toState(row), now, policy.calendar), policy, now);
  return true;
}

/** A new priority re-targets the clocks that still run, keeping the time used. */
export async function onTicketPriorityChange(tx: Tx, workspaceId: string, ticket: TicketLike, now = new Date()) {
  const { policy } = await loadSlaPolicy(tx, workspaceId);
  const target = resolveSlaTarget(policy, ticket.priority, ticket.accountTier);
  for (const row of await clocksOf(tx, workspaceId, ticket.id)) {
    if (row.metAt) continue;
    let c = toState(row);
    // Bank the time used under the old calendar before switching calendars.
    if (c.runningSince) c = { ...slaPause(c, now, policy.calendar), runningSince: now };
    c = { ...c, targetMinutes: row.kind === "response" ? target.response : target.resolution, calendar: target.calendar };
    await saveClock(tx, row, c, policy, now);
  }
}

export function slaClockDto(r: ClockRow, policy: SlaPolicy, now: Date) {
  const c = toState(r);
  return {
    kind: r.kind,
    target_minutes: r.targetMinutes,
    calendar: r.calendar,
    started_at: r.startedAt.toISOString(),
    due_at: r.dueAt?.toISOString() ?? null,
    paused: !r.runningSince && !r.metAt,
    used_minutes: slaUsedMinutes(c, now, policy.calendar),
    state: slaClockStatus(c, now, policy.calendar, policy.atRiskRatio),
    met_at: r.metAt?.toISOString() ?? null,
    breached_at: r.breachedAt?.toISOString() ?? null,
    policy_version: r.policyVersion,
  };
}

export async function getTicketSla(db: Db, workspaceId: string, ticket: TicketLike, now = new Date()) {
  const { policy } = await loadSlaPolicy(db, workspaceId);
  const rows = await db.select().from(slaClocks).where(and(eq(slaClocks.workspaceId, workspaceId), eq(slaClocks.ticketId, ticket.id)));
  return { priority: ticket.priority, tier: ticket.accountTier, clocks: rows.map((r) => slaClockDto(r, policy, now)) };
}

/** SLA state of many tickets at once (the queue): the worst clock per ticket. */
export async function slaSummaries(db: Db, workspaceId: string, ticketIds: string[], now = new Date()) {
  if (!ticketIds.length) return new Map<string, { state: string; due_at: string | null }>();
  const { policy } = await loadSlaPolicy(db, workspaceId);
  const rows = await db.select().from(slaClocks).where(and(eq(slaClocks.workspaceId, workspaceId), inArray(slaClocks.ticketId, ticketIds)));
  const rank = { breached: 4, at_risk: 3, running: 2, paused: 1, met: 0 } as const;
  const out = new Map<string, { state: string; due_at: string | null }>();
  for (const r of rows) {
    const d = slaClockDto(r, policy, now);
    const prev = out.get(r.ticketId);
    if (!prev || rank[d.state] > rank[prev.state as keyof typeof rank]) out.set(r.ticketId, { state: d.state, due_at: d.due_at });
  }
  return out;
}

/** Open tickets without clocks (created before COPS-12) get them, started now. */
export async function backfillSlaClocks(db: Db, workspaceId: string, now = new Date()) {
  const missing = await db
    .select({ id: engineeringTickets.id, priority: engineeringTickets.priority, accountTier: engineeringTickets.accountTier, status: engineeringTickets.status })
    .from(engineeringTickets)
    .leftJoin(slaClocks, eq(slaClocks.ticketId, engineeringTickets.id))
    .where(and(eq(engineeringTickets.workspaceId, workspaceId), inArray(engineeringTickets.status, [...TICKET_OPEN_STATUSES]), isNull(slaClocks.id)));
  for (const t of missing) await startSlaClocks(db, workspaceId, t, now);
  return missing.length;
}
