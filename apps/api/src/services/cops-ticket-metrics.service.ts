import { and, eq, gte, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { TICKET_OPEN_STATUSES } from "@skout/shared";
import { slaSummaries } from "./cops-sla.service.js";

/**
 * COPS-12 engineering dashboard metrics (Bible p.56). Each metric names its definition and the
 * window, so COPS-13 can reuse them. MTTA and MTTR are wall-clock means over tickets created in
 * the window; SLA attainment is reported separately as the breach rate.
 */
const { engineeringTickets, slaClocks, incidentTicketLinks } = schema;
const AGED_DAYS = 7;

export const TICKET_METRIC_DEFINITIONS = {
  open: "Tickets not resolved, verified or closed",
  aged: `Open tickets created more than ${AGED_DAYS} days ago`,
  mtta_minutes: "Mean minutes from creation to first response (first move out of triage or first customer update), tickets created in the window",
  mttr_minutes: "Mean minutes from creation to resolved, tickets created in the window",
  reopen_rate: "Tickets reopened at least once / tickets resolved, created in the window",
  breach_rate: "SLA clocks breached / SLA clocks finished or breached, tickets created in the window",
  incident_linked: "Open tickets linked to an incident",
  at_risk: "Open tickets with an SLA clock at risk or breached",
} as const;

export async function ticketMetrics(db: Db, workspaceId: string, f: { days: number; tier?: string; team?: string }, now = new Date()) {
  const since = new Date(now.getTime() - f.days * 86_400_000);
  const scope: SQL[] = [eq(engineeringTickets.workspaceId, workspaceId)];
  if (f.tier) scope.push(eq(engineeringTickets.accountTier, f.tier));
  if (f.team) scope.push(eq(engineeringTickets.team, f.team));
  const openList = sql.join(TICKET_OPEN_STATUSES.map((s) => sql`${s}`), sql`, `);
  const agedBefore = new Date(now.getTime() - AGED_DAYS * 86_400_000).toISOString();

  const [counts] = await db
    .select({
      open: sql<number>`count(*) filter (where ${engineeringTickets.status} in (${openList}))::int`,
      aged: sql<number>`count(*) filter (where ${engineeringTickets.status} in (${openList}) and ${engineeringTickets.createdAt} < ${agedBefore}::timestamptz)::int`,
    })
    .from(engineeringTickets)
    .where(and(...scope));

  const windowScope = and(...scope, gte(engineeringTickets.createdAt, since));
  const [rates] = await db
    .select({
      mtta: sql<number | null>`avg(extract(epoch from (${engineeringTickets.firstResponseAt} - ${engineeringTickets.createdAt})) / 60) filter (where ${engineeringTickets.firstResponseAt} is not null)`,
      mttr: sql<number | null>`avg(extract(epoch from (${engineeringTickets.resolvedAt} - ${engineeringTickets.createdAt})) / 60) filter (where ${engineeringTickets.resolvedAt} is not null)`,
      reopened: sql<number>`count(*) filter (where ${engineeringTickets.reopenCount} > 0)::int`,
      resolvedEver: sql<number>`count(*) filter (where ${engineeringTickets.resolvedAt} is not null or ${engineeringTickets.reopenCount} > 0)::int`,
    })
    .from(engineeringTickets)
    .where(windowScope);

  const [clocks] = await db
    .select({
      breached: sql<number>`count(*) filter (where ${slaClocks.breachedAt} is not null)::int`,
      finished: sql<number>`count(*) filter (where ${slaClocks.metAt} is not null or ${slaClocks.breachedAt} is not null)::int`,
    })
    .from(slaClocks)
    .innerJoin(engineeringTickets, eq(engineeringTickets.id, slaClocks.ticketId))
    .where(windowScope);

  const [linked] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(incidentTicketLinks)
    .innerJoin(engineeringTickets, eq(engineeringTickets.id, incidentTicketLinks.ticketId))
    .where(and(...scope, sql`${engineeringTickets.status} in (${openList})`));

  const openIds = (await db.select({ id: engineeringTickets.id }).from(engineeringTickets).where(and(...scope, sql`${engineeringTickets.status} in (${openList})`))).map((r) => r.id);
  const sla = await slaSummaries(db, workspaceId, openIds, now);
  const atRisk = [...sla.values()].filter((s) => s.state === "at_risk" || s.state === "breached").length;

  const round = (n: number | null | undefined) => (n == null ? null : Math.round(Number(n) * 10) / 10);
  const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : null);
  return {
    window_days: f.days,
    open: counts?.open ?? 0,
    aged: counts?.aged ?? 0,
    mtta_minutes: round(rates?.mtta),
    mttr_minutes: round(rates?.mttr),
    reopen_rate: ratio(rates?.reopened ?? 0, rates?.resolvedEver ?? 0),
    breach_rate: ratio(clocks?.breached ?? 0, clocks?.finished ?? 0),
    incident_linked: linked?.n ?? 0,
    at_risk: atRisk,
    definitions: TICKET_METRIC_DEFINITIONS,
  };
}
