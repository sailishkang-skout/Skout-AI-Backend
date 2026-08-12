import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import { detectBudgetFreeze, type ReplyTag } from "./reply-tagger.service.js";
import { recordSignal } from "./signal.service.js";
import { addSuppression } from "./suppression.service.js";

const log = createLogger("reply-tag-actions");
const { inboxThreads, prospectActivations } = schema;

/**
 * Apply self-intuitive follow-up actions after an inbound reply is tagged.
 * Human replies already stop the enrollment; tags refine thread status + suppressions.
 * `bodyText` (R18.2), when provided, lets a "negative" tag also raise a plain-language
 * negative_sentiment risk signal, and (with `openRouterApiKey`) runs a separate budget-freeze
 * language check regardless of tag — both optional so existing callers/tests still work.
 */
export async function applyReplyTagActions(
  db: Db,
  workspaceId: string,
  threadId: string,
  tag: ReplyTag,
  bodyText?: string,
  openRouterApiKey?: string
): Promise<void> {
  const [thread] = await db
    .select({
      id: inboxThreads.id,
      prospectId: inboxThreads.prospectId,
      status: inboxThreads.status,
    })
    .from(inboxThreads)
    .where(and(eq(inboxThreads.workspaceId, workspaceId), eq(inboxThreads.id, threadId)))
    .limit(1);

  if (!thread) return;

  const now = new Date();

  if (tag === "negative" && thread.prospectId) {
    const snippet = bodyText?.trim().slice(0, 240);
    try {
      await recordSignal(db, {
        entityType: "prospect",
        entityId: thread.prospectId,
        signalType: "negative_sentiment",
        reason: snippet
          ? `Reply on ${now.toISOString().slice(0, 10)} expressed negative sentiment: "${snippet}"`
          : `Reply on ${now.toISOString().slice(0, 10)} expressed negative sentiment.`,
        source: "reply-tagger",
        detectedAt: now,
      });
    } catch (err) {
      log.warn("reply-tag-actions: failed to record negative_sentiment signal", { threadId, err });
    }
  }

  // Budget-freeze language is a distinct risk signal from sentiment — checked regardless of
  // tag, before any early `return` below, so e.g. a positive-but-budget-frozen reply still flags.
  if (bodyText && openRouterApiKey && thread.prospectId) {
    try {
      const budgetFreeze = await detectBudgetFreeze(bodyText, openRouterApiKey);
      if (budgetFreeze?.detected) {
        await recordSignal(db, {
          entityType: "prospect",
          entityId: thread.prospectId,
          signalType: "budget_freeze",
          reason: budgetFreeze.snippet
            ? `Reply on ${now.toISOString().slice(0, 10)} mentioned a budget freeze: "${budgetFreeze.snippet}"`
            : `Reply on ${now.toISOString().slice(0, 10)} mentioned a budget freeze.`,
          source: "reply-tagger",
          detectedAt: now,
        });
      }
    } catch (err) {
      log.warn("reply-tag-actions: budget-freeze detection failed", { threadId, err });
    }
  }

  if (tag === "meeting_request" && thread.status !== "meeting_booked" && thread.status !== "closed") {
    await db
      .update(inboxThreads)
      .set({ status: "meeting_booked", statusChangedAt: now, updatedAt: now })
      .where(eq(inboxThreads.id, threadId));
    log.info("reply-tag-actions: marked meeting_booked", { threadId, workspaceId });
    return;
  }

  if (tag === "unsubscribe") {
    await db
      .update(inboxThreads)
      .set({ status: "closed", statusChangedAt: now, updatedAt: now })
      .where(eq(inboxThreads.id, threadId));

    if (thread.prospectId) {
      const [activation] = await db
        .select({ snapshot: prospectActivations.snapshot })
        .from(prospectActivations)
        .where(
          and(
            eq(prospectActivations.workspaceId, workspaceId),
            eq(prospectActivations.prospectId, thread.prospectId)
          )
        )
        .limit(1);
      const email = (activation?.snapshot as Record<string, unknown> | undefined)?.email;
      if (typeof email === "string" && email.includes("@")) {
        await addSuppression(db, workspaceId, email, "unsubscribed");
        log.info("reply-tag-actions: suppressed on unsubscribe tag", {
          threadId,
          workspaceId,
        });
      }
    }
  }
}
