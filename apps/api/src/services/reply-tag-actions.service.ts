import { eq, ne, or, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo, scopedById } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import {
  classifyConfidenceTier,
  detectBudgetFreeze,
  type NegativeSubtype,
  type ReplyTag,
} from "./reply-tagger.service.js";
import { recordSignal } from "./signal.service.js";
import { addSuppression, isSuppressed } from "./suppression.service.js";
import { createNotification } from "./notifications.service.js";
import { emitSkoutEvent } from "./skout-event.service.js";

const log = createLogger("reply-tag-actions");
const { inboxThreads, prospectActivations, tasks, workspaceMembers } = schema;

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md for the full audit and rationale; one of the 9
 * confirmed instances listed there (formalized in Task 17).
 *   - Tables touched directly: tasks (owned by apps/crm) - write only (creates the escalation
 *     task described below)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: reply-tag actions run synchronously inside the inbound-reply processing path;
 *     creating the escalation task via an HTTP call into apps/crm here would add latency and a
 *     new failure mode to reply handling for no benefit over a direct, transactional write
 *   - Review date: revisit once apps/crm's internal API surface exists (Wave 2)
 */

/**
 * Condition-engine spec's WRONG_PERSON handling: the base "stop the sequence for this contact"
 * already happens unconditionally for any human reply (see inbound-reply.service.ts) — this adds
 * the richer escalation the spec also wants: find another contact at the same account and hand
 * a human a task to try them instead, rather than just going quiet on the whole account.
 */
async function escalateWrongPerson(
  db: Db,
  config: Env,
  workspaceId: string,
  threadId: string,
  prospectId: string
): Promise<void> {
  const [current] = await db
    .select({
      companyDomain: sql<string | null>`${prospectActivations.snapshot} ->> 'companyDomain'`,
    })
    .from(prospectActivations)
    .where(scopedTo(prospectActivations, workspaceId, eq(prospectActivations.prospectId, prospectId)))
    .limit(1);
  const companyDomain = current?.companyDomain;
  if (!companyDomain) return;

  const candidates = await db
    .select({
      prospectId: prospectActivations.prospectId,
      email: sql<string | null>`${prospectActivations.snapshot} ->> 'email'`,
      fullName: sql<string | null>`${prospectActivations.snapshot} ->> 'fullName'`,
    })
    .from(prospectActivations)
    .where(
      scopedTo(prospectActivations, workspaceId, ne(prospectActivations.prospectId, prospectId), sql`${prospectActivations.snapshot} ->> 'companyDomain' = ${companyDomain}`)
    )
    .limit(10);

  let alternate: { prospectId: string; email: string | null; fullName: string | null } | undefined;
  for (const candidate of candidates) {
    if (!candidate.email) continue;
    if (await isSuppressed(db, workspaceId, candidate.email)) continue;
    alternate = candidate;
    break;
  }

  if (!alternate) {
    log.info("reply-tag-actions: wrong_person reply but no alternate contact found at account", {
      workspaceId,
      threadId,
      companyDomain,
    });
    return;
  }

  const label = alternate.fullName || alternate.email || alternate.prospectId;
  await db.insert(tasks).values({
    workspaceId,
    title: `Wrong person reached — try ${label} at this account instead`,
    priority: "medium",
    status: "open",
    type: "follow-up",
    relatedEntityType: "wrong_person_escalation",
    relatedEntityId: null,
    prospectId: alternate.prospectId,
    dueDate: new Date(),
  });

  const owners = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      scopedTo(workspaceMembers, workspaceId, or(eq(workspaceMembers.role, "owner"), eq(workspaceMembers.role, "admin")))
    );

  for (const { userId } of owners) {
    try {
      await createNotification(db, config, {
        workspaceId,
        userId,
        type: "reminder",
        title: "Wrong person reply — alternate contact found",
        body: `A reply said we reached the wrong person at this account. Found another contact — ${label} — and created a follow-up task to try them instead.`,
        entityType: "inbox_thread",
        entityId: threadId,
      });
    } catch (err) {
      log.warn("reply-tag-actions: failed to notify owner of wrong_person escalation", { err, workspaceId, userId, threadId });
    }
  }

  log.info("reply-tag-actions: wrong_person escalated to alternate contact", {
    workspaceId,
    threadId,
    alternateProspectId: alternate.prospectId,
  });
}

async function suppressThreadSender(db: Db, workspaceId: string, prospectId: string | null, reason: string): Promise<void> {
  if (!prospectId) return;
  const [activation] = await db
    .select({ snapshot: prospectActivations.snapshot })
    .from(prospectActivations)
    .where(scopedTo(prospectActivations, workspaceId, eq(prospectActivations.prospectId, prospectId)))
    .limit(1);
  const email = (activation?.snapshot as Record<string, unknown> | undefined)?.email;
  if (typeof email === "string" && email.includes("@")) {
    await addSuppression(db, workspaceId, email, reason);
    log.info("reply-tag-actions: suppressed", { workspaceId, prospectId, reason });
  }
}

export interface ApplyReplyTagActionsOptions {
  bodyText?: string;
  openRouterApiKey?: string;
  /** 0–1. Below MANUAL_REVIEW_CONFIDENCE_THRESHOLD, branch-deciding actions (suppression,
   * meeting_request status flip) are skipped in favor of a manual-review notification —
   * condition-engine spec §14/§41. Omit (or 1) to always auto-apply, e.g. for a human-set tag. */
  confidence?: number;
  negativeSubtype?: NegativeSubtype;
  /** The AI's short justification for the tag — persisted onto the thread when routed to
   * manual review, so the resolution UI can show a human why the model decided what it did. */
  reason?: string;
}

/**
 * Apply self-intuitive follow-up actions after an inbound reply is tagged.
 * Human replies already stop the enrollment; tags refine thread status + suppressions.
 * `bodyText` (R18.2), when provided, lets a "negative" tag also raise a plain-language
 * negative_sentiment risk signal, and (with `openRouterApiKey`) runs a separate budget-freeze
 * language check regardless of tag — both optional so existing callers/tests still work.
 */
export async function applyReplyTagActions(
  db: Db,
  config: Env,
  workspaceId: string,
  threadId: string,
  tag: ReplyTag,
  options: ApplyReplyTagActionsOptions = {}
): Promise<void> {
  const { bodyText, openRouterApiKey, negativeSubtype, reason } = options;
  const confidence = options.confidence ?? 1;

  const [thread] = await db
    .select({
      id: inboxThreads.id,
      prospectId: inboxThreads.prospectId,
      status: inboxThreads.status,
    })
    .from(inboxThreads)
    .where(scopedById(inboxThreads, workspaceId, threadId))
    .limit(1);

  if (!thread) return;

  const now = new Date();

  await emitSkoutEvent(db, config, {
    type: "reply.classified",
    tenantId: workspaceId,
    aggregateId: threadId,
    data: {
      workspaceId,
      threadId,
      prospectId: thread.prospectId,
      tag,
      confidence,
      negativeSubtype: negativeSubtype ?? null,
    },
  }).catch((err: unknown) => log.warn("reply-tag-actions: failed to emit reply.classified", { threadId, err }));

  if (tag === "negative" && thread.prospectId) {
    const snippet = bodyText?.trim().slice(0, 240);
    try {
      const signal = await recordSignal(db, {
        entityType: "prospect",
        entityId: thread.prospectId,
        signalType: "negative_sentiment",
        reason: snippet
          ? `Reply on ${now.toISOString().slice(0, 10)} expressed negative sentiment: "${snippet}"`
          : `Reply on ${now.toISOString().slice(0, 10)} expressed negative sentiment.`,
        source: "reply-tagger",
        detectedAt: now,
      });
      await emitSkoutEvent(db, config, {
        type: "signal.detected",
        tenantId: workspaceId,
        aggregateId: thread.prospectId,
        data: { workspaceId, signalId: signal.id, entityType: signal.entityType, entityId: signal.entityId, signalType: signal.signalType },
      }).catch((err: unknown) => log.warn("reply-tag-actions: failed to emit signal.detected", { threadId, err }));
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
        const signal = await recordSignal(db, {
          entityType: "prospect",
          entityId: thread.prospectId,
          signalType: "budget_freeze",
          reason: budgetFreeze.snippet
            ? `Reply on ${now.toISOString().slice(0, 10)} mentioned a budget freeze: "${budgetFreeze.snippet}"`
            : `Reply on ${now.toISOString().slice(0, 10)} mentioned a budget freeze.`,
          source: "reply-tagger",
          detectedAt: now,
        });
        await emitSkoutEvent(db, config, {
          type: "signal.detected",
          tenantId: workspaceId,
          aggregateId: thread.prospectId,
          data: { workspaceId, signalId: signal.id, entityType: signal.entityType, entityId: signal.entityId, signalType: signal.signalType },
        }).catch((err: unknown) => log.warn("reply-tag-actions: failed to emit signal.detected", { threadId, err }));
      }
    } catch (err) {
      log.warn("reply-tag-actions: budget-freeze detection failed", { threadId, err });
    }
  }

  // Everything below decides a sequence branch or suppresses a prospect — both irreversible-ish
  // (a suppressed prospect stops hearing from us entirely; a wrongly-flipped meeting_booked
  // status hides a thread that still needs outreach). Risk-signal logging above
  // (negative_sentiment, budget_freeze) already ran regardless — that's informational, not a
  // branch decision, so there's nothing to get "wrong" there.
  //
  // Three-tier confidence policy (condition-engine spec §14/§41):
  //   manual_review → skip the branch entirely, notify BEFORE anything is decided.
  //   cautious      → still apply the branch (spec: "configurable / cautious branch", not
  //                   "block"), but also raise a non-blocking FYI notification afterward.
  //   auto          → apply the branch silently, as before.
  const tier = classifyConfidenceTier(confidence);

  if (tier === "manual_review") {
    log.info("reply-tag-actions: low-confidence classification routed to manual review", {
      threadId,
      workspaceId,
      tag,
      confidence,
    });
    // Persist the suggestion so a manual-review resolution UI can list it and let a human
    // approve (apply the branch) or dismiss it, instead of it only ever surfacing as a
    // notification that's easy to lose track of.
    try {
      await db
        .update(inboxThreads)
        .set({
          needsReview: true,
          suggestedTag: tag,
          suggestedNegativeSubtype: negativeSubtype ?? null,
          suggestedConfidence: confidence,
          suggestedReason: reason ?? null,
          updatedAt: now,
        })
        .where(eq(inboxThreads.id, threadId));
    } catch (err) {
      log.warn("reply-tag-actions: failed to persist manual-review suggestion", { threadId, err });
    }
    try {
      await createNotification(db, config, {
        workspaceId,
        type: "reply_needs_review",
        title: "A reply needs manual review",
        body: `AI classified this reply as "${tag}"${negativeSubtype ? ` (${negativeSubtype})` : ""} with low confidence (${Math.round(
          confidence * 100
        )}%) — review it in the inbox before the sequence branch is decided automatically.`,
        entityType: "inbox_thread",
        entityId: threadId,
      });
    } catch (err) {
      log.warn("reply-tag-actions: failed to create manual-review notification", { threadId, err });
    }
    return;
  }

  if (tier === "cautious") {
    try {
      await createNotification(db, config, {
        workspaceId,
        type: "reply_auto_processed_fyi",
        title: "A reply was auto-processed with moderate confidence",
        body: `AI classified this reply as "${tag}"${negativeSubtype ? ` (${negativeSubtype})` : ""} at ${Math.round(
          confidence * 100
        )}% confidence and took the matching action automatically — worth a quick double-check.`,
        entityType: "inbox_thread",
        entityId: threadId,
      });
    } catch (err) {
      log.warn("reply-tag-actions: failed to create cautious-tier FYI notification", { threadId, err });
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
    await suppressThreadSender(db, workspaceId, thread.prospectId, "unsubscribed");
    return;
  }

  // A "negative" reply that's actually asking to stop being contacted must suppress just like
  // an explicit unsubscribe (condition-engine spec §11: DO_NOT_CONTACT → GLOBAL SUPPRESSION),
  // not just stop the current sequence — a plain "not interested" only stops this sequence.
  if (tag === "negative" && negativeSubtype === "do_not_contact") {
    await suppressThreadSender(db, workspaceId, thread.prospectId, "do_not_contact");
  }

  // WRONG_PERSON: the sequence is already stopped for this contact (any human reply pauses the
  // enrollment unconditionally — see inbound-reply.service.ts). This adds the richer behavior:
  // find another contact at the same account instead of just going quiet on the whole account.
  if (tag === "negative" && negativeSubtype === "wrong_person" && thread.prospectId) {
    try {
      await escalateWrongPerson(db, config, workspaceId, threadId, thread.prospectId);
    } catch (err) {
      log.warn("reply-tag-actions: wrong_person escalation failed", { threadId, err });
    }
  }
}
