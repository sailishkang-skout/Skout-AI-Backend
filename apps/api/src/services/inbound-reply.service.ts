import { and, eq, inArray, sql } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { getReplyTagQueue } from "../workers/reply-tag.queue.js";
import { dispatchWebhookEvent } from "./webhook.service.js";

const log = createLogger("inbound-reply.service");

const {
  inboxThreads,
  inboxMessages,
  sequenceEnrollments,
  sequenceEnrollmentSteps,
  suppressions,
  inboxes,
} = schema;

type DbClient = ReturnType<typeof createDb>["db"];

/** How long an OOO auto-reply defers the next cadence step by default — condition-engine
 * spec §12's "If no return date exists: Wait configured period → Resume". */
export const OOO_RESUME_WAIT_MS = 14 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InboundMessagePayload {
  fromAddress: string;
  toAddress: string;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  /** RFC 5322 Message-ID with angle brackets, e.g. <abc@smtp.example.com> */
  messageId?: string;
  /** RFC 5322 In-Reply-To header value */
  inReplyTo?: string;
  /** RFC 5322 References header value (space-separated list of Message-IDs) */
  references?: string;
  sentAt: Date;
  /** Lowercased header map for classification heuristics */
  rawHeaders?: Record<string, string>;
}

export type MessageClassification = "human" | "bounce" | "auto_reply";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function classifyInboundMessage(
  payload: Pick<InboundMessagePayload, "fromAddress" | "subject" | "rawHeaders">
): MessageClassification {
  const from = payload.fromAddress.toLowerCase();
  const subject = (payload.subject ?? "").toLowerCase();
  const headers = payload.rawHeaders ?? {};

  if (
    from.includes("mailer-daemon") ||
    from.startsWith("postmaster@") ||
    from.includes("mail-delivery-subsystem") ||
    from.includes("noreply+bounceback") ||
    headers["x-failed-recipients"] != null ||
    subject.includes("delivery status notification") ||
    subject.includes("undeliverable:") ||
    subject.includes("mail delivery failed") ||
    subject.includes("returned mail") ||
    subject.includes("delivery failure") ||
    subject.includes("failure notice") ||
    subject.includes("delivery has failed") ||
    (headers["content-type"]?.includes("multipart/report") &&
      headers["content-type"]?.includes("delivery-status"))
  ) {
    return "bounce";
  }

  const autoSubmitted = (headers["auto-submitted"] ?? "").toLowerCase();
  if (
    autoSubmitted === "auto-replied" ||
    autoSubmitted === "auto-generated" ||
    (headers["x-autoreply"] ?? "").toLowerCase() === "yes" ||
    headers["x-auto-response-suppress"] != null ||
    subject.startsWith("out of office") ||
    subject.startsWith("ooo:") ||
    subject.startsWith("automatic reply:") ||
    subject.startsWith("auto reply:") ||
    subject.startsWith("auto:")
  ) {
    return "auto_reply";
  }

  return "human";
}

// ---------------------------------------------------------------------------
// Header parsing helpers
// ---------------------------------------------------------------------------

function normalizeMessageId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed;
  return `<${trimmed}>`;
}

export function extractParentMessageIds(inReplyTo?: string, references?: string): string[] {
  const ids = new Set<string>();
  const pattern = /<([^>]+)>/g;
  for (const header of [inReplyTo, references]) {
    if (!header) continue;
    let m: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(header)) !== null) {
      if (m[1]) ids.add(`<${m[1]}>`);
    }
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Core ingestion
// ---------------------------------------------------------------------------

/**
 * Ingest one inbound email message.
 * - Deduplicates on messageId to handle repeated IMAP polls.
 * - Matches thread via RFC 5322 In-Reply-To / References headers.
 * - Creates a new thread (status='new') if no match found (cold inbound).
 * - Classifies as human / bounce / auto_reply and acts accordingly:
 *   - human     → status='replied', unreadCount++, enrollments paused, enqueues AI tagging
 *   - bounce    → status='bounced', suppresses email, enrollment stopped
 *   - auto_reply → appends message, no status or enrollment change
 */
export async function ingestInboundMessage(
  db: DbClient,
  workspaceId: string,
  inboxId: string,
  payload: InboundMessagePayload,
  config?: Pick<Env, "REDIS_URL" | "OPENROUTER_API_KEY">
): Promise<void> {
  // Deduplicate: skip if we've already stored this RFC 5322 message
  if (payload.messageId) {
    const msgId = normalizeMessageId(payload.messageId);
    const [existing] = await db
      .select({ id: inboxMessages.id })
      .from(inboxMessages)
      .innerJoin(inboxThreads, eq(inboxMessages.threadId, inboxThreads.id))
      .where(
        and(eq(inboxThreads.workspaceId, workspaceId), eq(inboxMessages.messageId, msgId))
      )
      .limit(1);
    if (existing) {
      log.debug("Skipping duplicate inbound message", { messageId: msgId });
      return;
    }
  }

  const classification = classifyInboundMessage(payload);

  // Find parent thread via email header chain
  let threadId: string | null = null;
  let enrollmentId: string | null = null;
  let prospectId: string | null = null;

  const parentIds = extractParentMessageIds(payload.inReplyTo, payload.references);
  if (parentIds.length > 0) {
    const [parentMsg] = await db
      .select({
        threadId: inboxMessages.threadId,
        enrollmentId: inboxThreads.enrollmentId,
        prospectId: inboxThreads.prospectId,
      })
      .from(inboxMessages)
      .innerJoin(inboxThreads, eq(inboxMessages.threadId, inboxThreads.id))
      .where(
        and(
          eq(inboxThreads.workspaceId, workspaceId),
          inArray(inboxMessages.messageId, parentIds)
        )
      )
      .limit(1);

    if (parentMsg) {
      threadId = parentMsg.threadId;
      enrollmentId = parentMsg.enrollmentId ?? null;
      prospectId = parentMsg.prospectId ?? null;
    }
  }

  const normalizedMessageId = payload.messageId ? normalizeMessageId(payload.messageId) : null;
  const now = new Date();

  let insertedMessageId: string | null = null;

  await db.transaction(async (tx) => {
    if (!threadId) {
      // Cold inbound or unresolved thread — create a new one
      const [newThread] = await tx
        .insert(inboxThreads)
        .values({
          workspaceId,
          inboxId,
          prospectId,
          subject: payload.subject ?? "(no subject)",
          status: "new",
          statusChangedAt: now,
          lastMessageAt: payload.sentAt,
        })
        .returning();
      threadId = newThread!.id;
    }

    const [inserted] = await tx
      .insert(inboxMessages)
      .values({
        threadId,
        direction: "inbound",
        fromAddress: payload.fromAddress,
        toAddress: payload.toAddress,
        subject: payload.subject,
        bodyText: payload.bodyText,
        bodyHtml: payload.bodyHtml,
        messageId: normalizedMessageId,
        inReplyTo: payload.inReplyTo,
        referencesHeader: payload.references,
        classification,
        sentAt: payload.sentAt,
      })
      .returning({ id: inboxMessages.id });
    insertedMessageId = inserted!.id;

    const newThreadStatus =
      classification === "bounce" ? "bounced" : classification === "human" ? "replied" : null;

    await tx
      .update(inboxThreads)
      .set({
        lastMessageAt: payload.sentAt,
        updatedAt: now,
        ...(newThreadStatus
          ? { status: newThreadStatus, statusChangedAt: now }
          : {}),
        // Increment unread counter for human replies
        ...(classification === "human"
          ? { unreadCount: sql`${inboxThreads.unreadCount} + 1` }
          : {}),
      })
      .where(eq(inboxThreads.id, threadId!));

    if (classification === "human" && enrollmentId) {
      await tx
        .update(sequenceEnrollments)
        .set({ status: "replied", completedAt: now })
        .where(
          and(
            eq(sequenceEnrollments.id, enrollmentId),
            eq(sequenceEnrollments.status, "active")
          )
        );
      await tx
        .update(sequenceEnrollmentSteps)
        .set({ status: "skipped" })
        .where(
          and(
            eq(sequenceEnrollmentSteps.enrollmentId, enrollmentId),
            eq(sequenceEnrollmentSteps.status, "scheduled")
          )
        );
      log.info("Human reply received — enrollment paused", { enrollmentId, workspaceId });
    }

    if (classification === "bounce" && enrollmentId) {
      await tx
        .update(sequenceEnrollments)
        .set({ status: "bounced", completedAt: now })
        .where(
          and(
            eq(sequenceEnrollments.id, enrollmentId),
            eq(sequenceEnrollments.status, "active")
          )
        );
      await tx
        .update(sequenceEnrollmentSteps)
        .set({ status: "skipped" })
        .where(
          and(
            eq(sequenceEnrollmentSteps.enrollmentId, enrollmentId),
            eq(sequenceEnrollmentSteps.status, "scheduled")
          )
        );
      log.info("Bounce received — enrollment stopped", { enrollmentId, workspaceId });
    }

    // Condition-engine spec §12: OOO must not be treated as no signal at all — the cadence
    // should pause rather than fire its next step while the prospect is confirmed away, then
    // resume automatically. This is deliberately a re-schedule, not an enrollment-status change:
    // sequence_enrollments_active_unique only constrains rows where status='active', so a
    // distinct "paused" status here would let a second enrollment attempt slip in underneath
    // this one. Pushing scheduledAt out (same mechanism as the HITL awaiting-draft defer in
    // executeEmailStep) keeps the enrollment legitimately "active" and lets the existing
    // enrollment worker just pick the step back up when it's due — no separate resume job needed.
    // We don't parse a return date out of the OOO body (spec's optional `ooo_until`) — that would
    // need its own AI call — so every OOO defers by the same fixed window regardless of what the
    // auto-reply says.
    if (classification === "auto_reply" && enrollmentId) {
      const resumeAt = new Date(now.getTime() + OOO_RESUME_WAIT_MS);
      await tx
        .update(sequenceEnrollmentSteps)
        .set({ scheduledAt: resumeAt, failureReason: "ooo_detected" })
        .where(
          and(
            eq(sequenceEnrollmentSteps.enrollmentId, enrollmentId),
            eq(sequenceEnrollmentSteps.status, "scheduled")
          )
        );
      log.info("Out-of-office auto-reply detected — cadence paused until return window", {
        enrollmentId,
        workspaceId,
        resumeAt,
      });
    }

    if (classification === "bounce") {
      // Keep deliverability counters in sync with classified bounces
      await tx
        .update(inboxes)
        .set({ bounceCount: sql`${inboxes.bounceCount} + 1`, updatedAt: now })
        .where(eq(inboxes.id, inboxId));
      // Suppress the bounced address to stop future sends
      await tx
        .insert(suppressions)
        .values({ workspaceId, email: payload.fromAddress, reason: "bounced" })
        .onConflictDoNothing();
    }
  });

  // Enqueue async AI tagging for human replies (fire-and-forget; graceful when no key)
  if (
    classification === "human" &&
    threadId &&
    payload.bodyText &&
    config?.REDIS_URL &&
    config?.OPENROUTER_API_KEY
  ) {
    try {
      const q = getReplyTagQueue(config as Parameters<typeof getReplyTagQueue>[0]);
      await q.add("tag-reply", {
        threadId: threadId!,
        messageId: insertedMessageId ?? "",
        workspaceId,
        bodyText: payload.bodyText,
      });
    } catch (err) {
      log.warn("Failed to enqueue reply-tag job — tagging skipped", { threadId, err });
    }
  }

  log.info("Inbound message ingested", {
    workspaceId,
    inboxId,
    threadId,
    classification,
    messageId: normalizedMessageId,
  });

  if (classification === "human" && config?.REDIS_URL) {
    dispatchWebhookEvent(db, config as Env, "reply.received", workspaceId, {
      threadId: threadId ?? null,
      inboxId,
      enrollmentId,
      prospectId,
      fromAddress: payload.fromAddress,
      subject: payload.subject ?? null,
      messageId: normalizedMessageId,
    }).catch((err: unknown) => log.warn("webhook dispatch failed", { err, event: "reply.received" }));
  }
}
