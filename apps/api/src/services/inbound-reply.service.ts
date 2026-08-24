import { and, eq, inArray, sql } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { enqueueReplyTagJob } from "../workers/reply-tag.queue.js";
import { dispatchWebhookEvent } from "./webhook.service.js";
import { extractOooReturnDate } from "./reply-tagger.service.js";

const log = createLogger("inbound-reply.service");

const {
  inboxThreads,
  inboxMessages,
  sequenceEnrollments,
  sequenceEnrollmentSteps,
  sequenceSteps,
  suppressions,
  inboxes,
} = schema;

/** Soft bounces retry this many times (mirrors retryTransientFailure's own default — condition-
 * engine spec §40) before falling back to hard-bounce treatment (suppress + stop). */
const DEFAULT_SOFT_BOUNCE_MAX_ATTEMPTS = 3;
const SOFT_BOUNCE_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

/** Sanity cap on an AI-parsed OOO return date — anything further out than this reads as a
 * misparse rather than a real return date, so we keep the fixed-window fallback instead. */
const OOO_PARSED_DATE_MAX_MS = 60 * 24 * 60 * 60 * 1000;

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

export type BounceType = "hard" | "soft" | "unknown";

const HARD_BOUNCE_PATTERN =
  /\b5\.\d\.\d\b|user unknown|no such user|does not exist|invalid recipient|mailbox unavailable|address rejected|recipient rejected|unknown user account/i;
const SOFT_BOUNCE_PATTERN =
  /\b4\.\d\.\d\b|mailbox full|quota exceeded|over quota|try again later|temporarily deferred|temporary failure|mailbox temporarily/i;

/**
 * Distinguishes a permanent (hard) DSN bounce from a transient (soft) one, using the enhanced
 * status code (RFC 3463 — 5.x.x permanent, 4.x.x transient) or keyword fallback when no status
 * code is present. Defaults to "unknown" (treated the same as hard, for safety — we'd rather
 * suppress a real address too early than keep hammering a genuinely dead one) rather than
 * guessing soft when the signal is ambiguous.
 */
export function classifyBounceType(
  payload: Pick<InboundMessagePayload, "subject" | "bodyText" | "bodyHtml">
): BounceType {
  const haystack = [payload.subject, payload.bodyText, payload.bodyHtml].filter(Boolean).join(" ");
  if (HARD_BOUNCE_PATTERN.test(haystack)) return "hard";
  if (SOFT_BOUNCE_PATTERN.test(haystack)) return "soft";
  return "unknown";
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
 *   - bounce    → hard/unknown: status='bounced', suppresses email, enrollment stopped.
 *                 soft (transient — mailbox full, temporary defer): step deferred for retry
 *                 up to the step's retry policy, thread status unchanged, no suppression —
 *                 falls back to the hard-bounce behavior once retries are exhausted.
 *   - auto_reply → appends message, no status or enrollment change
 */
/**
 * Best-effort refinement of the fixed-window OOO reschedule: tries to parse an actual return
 * date out of the auto-reply body and, if found and sane, overwrites the fallback resumeAt that
 * was already set synchronously inside the main transaction. Never awaited by the caller — an
 * AI call has no business blocking the inbound-mail ingest path, and the fixed-window fallback
 * is already a safe, correct schedule on its own.
 */
export async function refineOooResumeDate(
  db: DbClient,
  enrollmentId: string,
  bodyText: string,
  now: Date,
  apiKey: string
): Promise<void> {
  const parsed = await extractOooReturnDate(bodyText, apiKey, now);
  if (!parsed?.returnDate) return;

  const resumeAt = new Date(`${parsed.returnDate}T09:00:00.000Z`);
  if (Number.isNaN(resumeAt.getTime())) return;
  const deltaMs = resumeAt.getTime() - now.getTime();
  if (deltaMs <= 0 || deltaMs > OOO_PARSED_DATE_MAX_MS) {
    log.info("OOO return date parsed but out of sane range — keeping fixed-window fallback", {
      enrollmentId,
      parsedReturnDate: parsed.returnDate,
    });
    return;
  }

  // Only overwrite the step we ourselves deferred — if it's moved on (advanced, cancelled,
  // re-scheduled by something else) since the synchronous fallback ran, leave it alone.
  await db
    .update(sequenceEnrollmentSteps)
    .set({ scheduledAt: resumeAt, failureReason: "ooo_detected (return date parsed)" })
    .where(
      and(
        eq(sequenceEnrollmentSteps.enrollmentId, enrollmentId),
        eq(sequenceEnrollmentSteps.status, "scheduled"),
        eq(sequenceEnrollmentSteps.failureReason, "ooo_detected")
      )
    );
  log.info("OOO return date parsed — cadence resume date refined", {
    enrollmentId,
    resumeAt,
  });
}

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
  const bounceType = classification === "bounce" ? classifyBounceType(payload) : null;

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
  // Whether this bounce should result in permanently suppressing the address. Defaults to the
  // hard-bounce behavior; a soft bounce that successfully defers for retry flips this off below.
  let suppressForBounce = classification === "bounce" && bounceType !== "soft";

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

    // A soft bounce is transient (mailbox full, temporary deferral) — the thread isn't
    // permanently dead, so it doesn't flip to the terminal "bounced" status the way a hard
    // bounce does.
    const newThreadStatus =
      classification === "bounce" && bounceType !== "soft"
        ? "bounced"
        : classification === "human"
          ? "replied"
          : null;

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
      // Soft bounces get a fallback retry chain instead of an immediate permanent stop: the
      // failure is presumed transient, so we defer the currently-scheduled step and let the
      // enrollment worker naturally pick it back up, capped at the step's own retry policy
      // (falls back to hard-bounce treatment once exhausted — same "never retry forever"
      // guarantee as retryTransientFailure's own cap, condition-engine spec §40).
      let softBounceRetried = false;
      if (bounceType === "soft") {
        const [scheduledStep] = await tx
          .select({
            enrollmentStepId: sequenceEnrollmentSteps.id,
            attemptCount: sequenceEnrollmentSteps.attemptCount,
            retryMaxAttempts: sequenceSteps.retryMaxAttempts,
          })
          .from(sequenceEnrollmentSteps)
          .innerJoin(sequenceSteps, eq(sequenceEnrollmentSteps.stepId, sequenceSteps.id))
          .where(
            and(
              eq(sequenceEnrollmentSteps.enrollmentId, enrollmentId),
              eq(sequenceEnrollmentSteps.status, "scheduled")
            )
          )
          .limit(1);

        if (scheduledStep) {
          const maxAttempts = scheduledStep.retryMaxAttempts ?? DEFAULT_SOFT_BOUNCE_MAX_ATTEMPTS;
          const nextAttempt = scheduledStep.attemptCount + 1;
          if (nextAttempt <= maxAttempts) {
            const resumeAt = new Date(now.getTime() + SOFT_BOUNCE_RETRY_DELAY_MS * nextAttempt);
            await tx
              .update(sequenceEnrollmentSteps)
              .set({
                attemptCount: nextAttempt,
                scheduledAt: resumeAt,
                failureReason: `soft_bounce (attempt ${nextAttempt}/${maxAttempts})`,
              })
              .where(eq(sequenceEnrollmentSteps.id, scheduledStep.enrollmentStepId));
            log.info("Soft bounce received — step deferred for retry", {
              enrollmentId,
              workspaceId,
              attempt: nextAttempt,
              maxAttempts,
              resumeAt,
            });
            softBounceRetried = true;
          }
        }
      }

      if (!softBounceRetried) {
        suppressForBounce = true;
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
        log.info("Bounce received — enrollment stopped", {
          enrollmentId,
          workspaceId,
          bounceType: bounceType ?? "unknown",
        });
      }
    }

    // Condition-engine spec §12: OOO must not be treated as no signal at all — the cadence
    // should pause rather than fire its next step while the prospect is confirmed away, then
    // resume automatically. This is deliberately a re-schedule, not an enrollment-status change:
    // sequence_enrollments_active_unique only constrains rows where status='active', so a
    // distinct "paused" status here would let a second enrollment attempt slip in underneath
    // this one. Pushing scheduledAt out (same mechanism as the HITL awaiting-draft defer in
    // executeEmailStep) keeps the enrollment legitimately "active" and lets the existing
    // enrollment worker just pick the step back up when it's due — no separate resume job needed.
    // Every OOO defers by the same fixed window synchronously here — a safe schedule that never
    // depends on AI latency. refineOooResumeDate() below (fire-and-forget, after this transaction
    // commits) then tries to parse an actual return date out of the body (spec's optional
    // `ooo_until`) and tightens the schedule if one is confidently found.
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
      // Keep deliverability counters in sync with classified bounces — tracked regardless of
      // hard/soft, since both are real deliverability signal.
      await tx
        .update(inboxes)
        .set({ bounceCount: sql`${inboxes.bounceCount} + 1`, updatedAt: now })
        .where(eq(inboxes.id, inboxId));
      // Only permanently suppress for hard bounces (or a soft bounce that exhausted its retry
      // chain) — a soft bounce still being retried isn't confirmed dead yet.
      if (suppressForBounce) {
        await tx
          .insert(suppressions)
          .values({
            workspaceId,
            email: payload.fromAddress,
            reason: bounceType === "soft" ? "bounced_soft_exhausted" : "bounced",
          })
          .onConflictDoNothing();
      }
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
      await enqueueReplyTagJob(config as Parameters<typeof enqueueReplyTagJob>[0], {
        threadId: threadId!,
        messageId: insertedMessageId ?? "",
        workspaceId,
        bodyText: payload.bodyText,
      });
    } catch (err) {
      log.warn("Failed to enqueue reply-tag job — tagging skipped", { threadId, err });
    }
  }

  // Best-effort OOO return-date refinement (fire-and-forget; graceful when no key) — condition-
  // engine spec §12's optional `ooo_until`.
  if (classification === "auto_reply" && enrollmentId && payload.bodyText && config?.OPENROUTER_API_KEY) {
    refineOooResumeDate(db, enrollmentId, payload.bodyText, now, config.OPENROUTER_API_KEY).catch(
      (err: unknown) => log.warn("OOO return-date refinement failed", { enrollmentId, err })
    );
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
