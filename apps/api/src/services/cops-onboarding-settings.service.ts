import { eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { writeCopsAudit } from "./cops-platform.service.js";
import { stopAccountFollowUps } from "./cops-stop.service.js";

/**
 * COPS-05 onboarding settings and the "critical support escalation" stop condition (Appendix C,
 * "if configured"). Off by default (COPS-05 Q5). When a workspace turns it on, a TicketEscalated
 * event with a critical severity stops the account's onboarding follow-up. COPS-06 emits the event;
 * COPS-07 folds this setting into the versioned admin configuration.
 */
const { copsOnboardingSettings } = schema;

export const CRITICAL_SEVERITIES = new Set(["critical", "p1", "sev1", "sev-1", "s1"]);

export async function getOnboardingSettings(db: Db, workspaceId: string) {
  const [row] = await db.select().from(copsOnboardingSettings).where(eq(copsOnboardingSettings.workspaceId, workspaceId));
  return { stop_on_critical_escalation: row?.stopOnCriticalEscalation ?? false, updated_at: row?.updatedAt?.toISOString() ?? null };
}

export async function setOnboardingSettings(
  db: Db,
  ctx: { workspaceId: string; userId: string; requestId: string },
  input: { stop_on_critical_escalation: boolean; reason: string }
) {
  const before = await getOnboardingSettings(db, ctx.workspaceId);
  await db.transaction(async (tx) => {
    await tx
      .insert(copsOnboardingSettings)
      .values({ workspaceId: ctx.workspaceId, stopOnCriticalEscalation: input.stop_on_critical_escalation, updatedBy: ctx.userId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: copsOnboardingSettings.workspaceId,
        set: { stopOnCriticalEscalation: input.stop_on_critical_escalation, updatedBy: ctx.userId, updatedAt: new Date() },
      });
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "onboarding_settings",
      entityId: ctx.workspaceId,
      action: "onboarding_settings.updated",
      before: { stop_on_critical_escalation: before.stop_on_critical_escalation },
      after: { stop_on_critical_escalation: input.stop_on_critical_escalation },
      reason: input.reason,
      override: true,
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
  });
  return getOnboardingSettings(db, ctx.workspaceId);
}

/** TicketEscalated consumer: stops the follow-up when the workspace opted in and the severity is critical. */
export async function handleTicketEscalated(
  db: Db,
  event: { tenant_id: string; correlation_id: string; payload: { account_id: string; severity: string } }
): Promise<number> {
  if (!CRITICAL_SEVERITIES.has(String(event.payload.severity).toLowerCase())) return 0;
  const settings = await getOnboardingSettings(db, event.tenant_id);
  if (!settings.stop_on_critical_escalation) return 0;
  return stopAccountFollowUps(db, {
    workspaceId: event.tenant_id,
    accountId: event.payload.account_id,
    reason: "CRITICAL_ESCALATION",
    actor: { type: "system", id: null },
    correlationId: event.correlation_id,
  });
}
