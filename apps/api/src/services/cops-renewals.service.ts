import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, ne } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { appendCopsEvent, createCopsEvent, periodAmountMinor, renewalPolicySchema } from "@skout/shared";
import { writeCopsAudit } from "./cops-platform.service.js";
import { getConfig } from "./cops-admin-config.service.js";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-08 additions).
 *   - Tables touched directly: deals - read of the original opportunity (name, owner, pipeline) and
 *     insert of one renewal opportunity per subscription term; pipelineStages - read (first stage of
 *     that pipeline) (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: "one renewal opportunity per term" is only certain when the opportunity, the mark on the
 *     subscription and the RenewalOpened event are written in one transaction under the subscription's
 *     row lock. An HTTP call into apps/crm cannot take part in that transaction, and a retry after a
 *     lost response would create a second opportunity.
 *   - Review date: revisit when apps/crm's internal API covers idempotent, transactional creates
 */
const { subscriptions, subscriptionItems, deals, pipelineStages } = schema;

/**
 * COPS-08 renewals (Bible p.37): a renewal opportunity is opened ahead of the end of a term, once.
 * It is a first-class opportunity on the same account, in the same pipeline as the original, owned
 * by the same person, valued at one more term of the current seats.
 */
export async function runRenewals(db: Db, now: Date = new Date(), scope: { workspaceId?: string } = {}, requestId: string = randomUUID()): Promise<Array<{ subscription_id: string; opportunity_id: string }>> {
  const opened: Array<{ subscription_id: string; opportunity_id: string }> = [];
  const leadDays = new Map<string, number>();
  const candidates = await db
    .select({ id: subscriptions.id, workspaceId: subscriptions.workspaceId, termEnd: subscriptions.termEnd })
    .from(subscriptions)
    .where(
      and(
        ne(subscriptions.status, "closed"),
        isNull(subscriptions.renewalOpportunityId),
        // The widest lead time allowed by the config schema; the exact one is checked per workspace below.
        lte(subscriptions.termEnd, new Date(now.getTime() + 366 * 86_400_000)),
        scope.workspaceId ? eq(subscriptions.workspaceId, scope.workspaceId) : undefined
      )
    );

  for (const candidate of candidates) {
    if (!leadDays.has(candidate.workspaceId)) {
      const parsed = renewalPolicySchema.safeParse((await getConfig(db, candidate.workspaceId, "renewal_policy", "default"))?.value);
      // No readable policy: open nothing for this workspace rather than guess a lead time.
      leadDays.set(candidate.workspaceId, parsed.success ? parsed.data.lead_days : -1);
    }
    const lead = leadDays.get(candidate.workspaceId)!;
    if (lead < 0 || candidate.termEnd.getTime() - lead * 86_400_000 > now.getTime()) continue;

    await db.transaction(async (tx) => {
      // The row lock is what makes this once per term: a concurrent pass waits here, then sees the mark.
      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, candidate.id)).for("update").limit(1);
      if (!sub || sub.status === "closed" || sub.renewalOpportunityId) return;
      const [origin] = await tx
        .select({ name: deals.name, ownerId: deals.ownerId, pipelineId: deals.pipelineId, stageId: deals.stageId })
        .from(deals)
        .where(and(eq(deals.id, sub.opportunityId), eq(deals.workspaceId, sub.workspaceId)))
        .limit(1);
      if (!origin) return;
      const [firstStage] = await tx.select({ id: pipelineStages.id }).from(pipelineStages).where(eq(pipelineStages.pipelineId, origin.pipelineId)).orderBy(asc(pipelineStages.orderIndex)).limit(1);
      const items = await tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub.id));
      const valueMinor = periodAmountMinor(items.map((i) => ({ quantity: i.quantity, unit_amount_minor: Number(i.unitAmountMinor) })), sub.termMonths);

      const [deal] = await tx
        .insert(deals)
        .values({
          workspaceId: sub.workspaceId,
          companyId: sub.accountId,
          pipelineId: origin.pipelineId,
          stageId: firstStage?.id ?? origin.stageId,
          ownerId: origin.ownerId,
          name: `Renewal: ${origin.name}`.slice(0, 200),
          amount: (valueMinor / 100).toFixed(2),
          currency: sub.currency,
          closeDate: sub.termEnd.toISOString().slice(0, 10),
          dealType: "renewal",
        })
        .returning({ id: deals.id });
      await tx.update(subscriptions).set({ renewalOpportunityId: deal!.id, renewalOpenedAt: now, updatedAt: now }).where(eq(subscriptions.id, sub.id));
      await writeCopsAudit(tx, {
        tenantId: sub.workspaceId,
        actor: { type: "system", id: "subscription-renewals" },
        entityType: "subscription",
        entityId: sub.id,
        action: "subscription.renewal_opened",
        after: { opportunity_id: deal!.id, term_end: sub.termEnd.toISOString(), value_minor: valueMinor, currency: sub.currency },
        correlationId: requestId,
        sourceChannel: "system",
        occurredAt: now,
      });
      await appendCopsEvent(
        tx as never,
        createCopsEvent({
          eventType: "RenewalOpened",
          tenantId: sub.workspaceId,
          aggregateType: "opportunity",
          aggregateId: deal!.id,
          actor: { type: "system", id: "subscription-renewals" },
          correlationId: requestId,
          payload: { subscription_id: sub.id, account_id: sub.accountId, opportunity_id: deal!.id, original_opportunity_id: sub.opportunityId, term_end: sub.termEnd.toISOString() },
          occurredAt: now,
        })
      );
      opened.push({ subscription_id: sub.id, opportunity_id: deal!.id });
    });
  }
  return opened;
}
