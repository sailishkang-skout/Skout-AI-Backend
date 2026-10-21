import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { appendCopsEvent, createCopsEvent, slaClockStatus, type SlaCalendarKind, type SlaClockKind } from "@skout/shared";
import { createLogger } from "@skout/observability";
import { getCopsNotificationRecipients, type CopsNotificationRoleKey } from "./cops-notification-routing.js";
import { backfillSlaClocks, loadSlaPolicy } from "./cops-sla.service.js";

/**
 * COPS-12 SLA escalation (Bible p.52: "escalate SLA risk before breach"). Runs in the COPS
 * evaluator tick. For every clock that still runs:
 *   - at risk (the policy's ratio of the target used, 75% by default): an in-app notification to
 *     the assignee and the Engineering role, once per clock;
 *   - breached: breached_at is set, the same people and CS are notified, and TicketSlaBreached is
 *     emitted, once per clock.
 * The notification id is derived from the clock and the stage, so a re-run never duplicates one.
 */
const { slaClocks, engineeringTickets, notifications } = schema;
const log = createLogger("cops-sla-sweep");
const AT_RISK_ROLES: readonly CopsNotificationRoleKey[] = ["engineering"];
const BREACH_ROLES: readonly CopsNotificationRoleKey[] = ["engineering", "cs"];

function stableId(key: string): string {
  const h = createHash("sha256").update(`cops-sla:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const CLOCK_LABEL: Record<string, string> = { response: "first response", resolution: "resolution" };

async function notify(db: Db, workspaceId: string, userIds: string[], input: { type: string; title: string; body: string; ticketId: string; key: string }) {
  let written = 0;
  for (const userId of new Set(userIds)) {
    const [row] = await db
      .insert(notifications)
      .values({ workspaceId, userId, type: input.type, title: input.title, body: input.body, entityType: "engineering_ticket", entityId: input.ticketId, sourceEventId: stableId(input.key), deliveredChannels: ["in_app"] })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    if (row) written++;
  }
  return written;
}

export async function runSlaSweep(db: Db, now = new Date()) {
  const workspaces = await db.selectDistinct({ id: engineeringTickets.workspaceId }).from(engineeringTickets).where(sql`${engineeringTickets.status} not in ('resolved','verified','closed')`);
  let atRisk = 0;
  let breached = 0;
  let backfilled = 0;
  for (const { id: workspaceId } of workspaces) {
    try {
      backfilled += await backfillSlaClocks(db, workspaceId, now);
      const { policy } = await loadSlaPolicy(db, workspaceId);
      const rows = await db
        .select({ clock: slaClocks, ticket: { id: engineeringTickets.id, title: engineeringTickets.title, priority: engineeringTickets.priority, accountId: engineeringTickets.accountId, assigneeId: engineeringTickets.assigneeId } })
        .from(slaClocks)
        .innerJoin(engineeringTickets, eq(engineeringTickets.id, slaClocks.ticketId))
        .where(and(eq(slaClocks.workspaceId, workspaceId), isNull(slaClocks.metAt), isNull(slaClocks.breachNotifiedAt)));
      const engineering = await getCopsNotificationRecipients(db, workspaceId, AT_RISK_ROLES);
      const breachTeam = await getCopsNotificationRecipients(db, workspaceId, BREACH_ROLES);
      for (const { clock, ticket } of rows) {
        const status = slaClockStatus(
          { kind: clock.kind as SlaClockKind, targetMinutes: clock.targetMinutes, calendar: clock.calendar as SlaCalendarKind, usedMinutes: clock.usedMinutes, runningSince: clock.runningSince, metAt: clock.metAt, breachedAt: clock.breachedAt },
          now,
          policy.calendar,
          policy.atRiskRatio
        );
        const label = CLOCK_LABEL[clock.kind] ?? clock.kind;
        const who = [...(ticket.assigneeId ? [ticket.assigneeId] : [])];
        if (status === "breached") {
          await db.transaction(async (tx) => {
            const [claimed] = await tx
              .update(slaClocks)
              .set({ breachedAt: clock.breachedAt ?? now, breachNotifiedAt: now, updatedAt: now })
              .where(and(eq(slaClocks.id, clock.id), isNull(slaClocks.breachNotifiedAt)))
              .returning({ id: slaClocks.id });
            if (!claimed) return;
            await appendCopsEvent(
              tx as never,
              createCopsEvent({
                eventType: "TicketSlaBreached",
                tenantId: workspaceId,
                aggregateType: "ticket",
                aggregateId: ticket.id,
                actor: { type: "system", id: null },
                payload: { ticket_id: ticket.id, account_id: ticket.accountId, clock: clock.kind as SlaClockKind, priority: ticket.priority, target_minutes: clock.targetMinutes },
              })
            );
            breached++;
          });
          await notify(db, workspaceId, [...who, ...breachTeam], { type: "ticket_sla_breached", title: `SLA breached: ${ticket.title}`, body: `${ticket.priority.toUpperCase()} ${label} target of ${clock.targetMinutes} minutes has passed.`, ticketId: ticket.id, key: `${clock.id}:breach` });
        } else if (status === "at_risk" && !clock.atRiskNotifiedAt) {
          const [claimed] = await db
            .update(slaClocks)
            .set({ atRiskNotifiedAt: now, updatedAt: now })
            .where(and(eq(slaClocks.id, clock.id), isNull(slaClocks.atRiskNotifiedAt)))
            .returning({ id: slaClocks.id });
          if (!claimed) continue;
          atRisk++;
          await notify(db, workspaceId, [...who, ...engineering], { type: "ticket_sla_at_risk", title: `SLA at risk: ${ticket.title}`, body: `${ticket.priority.toUpperCase()} ${label} due ${clock.dueAt?.toISOString() ?? "soon"}.`, ticketId: ticket.id, key: `${clock.id}:at_risk` });
        }
      }
    } catch (err) {
      log.error("SLA sweep failed for a workspace", err, { workspaceId });
    }
  }
  return { atRisk, breached, backfilled };
}

