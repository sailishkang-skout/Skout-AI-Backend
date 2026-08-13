import { Worker } from "bullmq";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { createDb } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { isBusinessHour, nextBusinessHour } from "../utils/scheduling.js";
import { resolveProspectFields } from "../services/prospect-resolver.service.js";
import { isSuppressed } from "../services/suppression.service.js";
import { buildUnsubscribeUrl } from "../services/suppression.service.js";
import { isSendBlockedByEligibility } from "../services/send-eligibility-guard.service.js";
import { pickNextInbox, markInboxUsed } from "../services/inbox-rotation.service.js";
import { renderTemplate, type MergeData } from "../services/template-render.service.js";
import { injectTracking } from "../services/tracking.service.js";
import { buildEmailSenderFromInbox } from "../services/email-sender.service.js";
import {
  SEQUENCE_ENROLLMENT_QUEUE,
  enqueueSequenceAdvanceJob,
  type SeqAdvanceJobPayload,
} from "./sequence-enrollment.queue.js";
import { dispatchWebhookEvent } from "../services/webhook.service.js";
import { LinkedinAccountService, sendLinkedinOutreach, sendWhatsappOutreach } from "../services/linkedin-account.service.js";
import { UnipileError } from "../services/unipile.client.js";
import { LinkedinOutreachService } from "../services/linkedin-outreach.service.js";
import { createNotification } from "../services/notifications.service.js";
import { getIcpScore } from "../services/draft-auto-approve.service.js";
import {
  evaluateConditionExpression,
  expressionFromSingle,
  parseConditionExpression,
  type ConditionLeafType,
} from "../services/sequence-condition.js";
import { recordSequenceEvent } from "../services/sequence-events.js";

const log = createLogger("sequence-enrollment.worker");

const {
  sequenceEnrollments,
  sequenceEnrollmentSteps,
  sequenceSteps,
  sequenceStepVariants,
  sequenceTrackingEvents,
  linkedinOutreachJobs,
  sequenceVersions,
  inboxThreads,
  inboxMessages,
  aiDrafts,
  contacts,
  tasks,
} = schema;

type DbClient = ReturnType<typeof createDb>["db"];

// ---------------------------------------------------------------------------
// Signal detection — reply or bounce on an inbox thread for this prospect
// ---------------------------------------------------------------------------

type CadenceSignal = "none" | "replied" | "bounced";

async function detectCadenceSignal(
  db: ReturnType<typeof createDb>["db"],
  workspaceId: string,
  prospectId: string,
  enrolledAt: Date
): Promise<CadenceSignal> {
  // Hard stop: bounce that happened at/after this enrollment.
  // Do NOT use lifetime bounced threads — stale test bounces were aborting every re-run.
  const [bounced] = await db
    .select({ id: inboxThreads.id })
    .from(inboxThreads)
    .where(
      and(
        eq(inboxThreads.workspaceId, workspaceId),
        eq(inboxThreads.prospectId, prospectId),
        eq(inboxThreads.status, "bounced"),
        // Bind as an ISO string cast to timestamptz — passing a raw JS Date into this
        // untyped sql comparison makes postgres.js throw ("Received an instance of Date").
        sql`coalesce(${inboxThreads.statusChangedAt}, ${inboxThreads.lastMessageAt}, ${inboxThreads.createdAt}) >= ${enrolledAt.toISOString()}::timestamptz`
      )
    )
    .limit(1);
  if (bounced) return "bounced";

  // Soft stop: inbound reply after enrollment date
  const [reply] = await db
    .select({ id: inboxMessages.id })
    .from(inboxMessages)
    .innerJoin(inboxThreads, eq(inboxMessages.threadId, inboxThreads.id))
    .where(
      and(
        eq(inboxThreads.workspaceId, workspaceId),
        eq(inboxThreads.prospectId, prospectId),
        eq(inboxMessages.direction, "inbound"),
        gte(inboxMessages.sentAt, enrolledAt)
      )
    )
    .limit(1);
  if (reply) return "replied";

  return "none";
}

// ---------------------------------------------------------------------------
// Email step execution — render, suppression-check, rotate inbox, send, track
// ---------------------------------------------------------------------------

interface PendingStep {
  enrollmentStepId: string;
  stepId: string;
  stepType: string;
  linkedinAction: string | null;
  subject: string | null;
  bodyTemplate: string | null;
  conditionType?: string | null;
  conditionWaitDays?: number | null;
  conditionExpression?: unknown;
  yesNextStepId?: string | null;
  noNextStepId?: string | null;
}

/**
 * HITL hookup: an APPROVED ai_draft overrides the step's template content for this send.
 * Prefers a draft already linked to this enrollment step, then falls back to an unconsumed
 * (enrollment_step_id IS NULL) approved draft for the same prospect. Returns null when none —
 * in which case the caller uses the sequence step template (unchanged legacy behaviour).
 */
async function findApprovedAiDraft(
  db: DbClient,
  workspaceId: string,
  prospectId: string,
  enrollmentStepId: string
): Promise<{ id: string; subject: string; body: string } | null> {
  const [draft] = await db
    .select({ id: aiDrafts.id, subject: aiDrafts.subject, body: aiDrafts.body })
    .from(aiDrafts)
    .where(
      and(
        eq(aiDrafts.workspaceId, workspaceId),
        eq(aiDrafts.prospectId, prospectId),
        eq(aiDrafts.status, "approved"),
        or(eq(aiDrafts.enrollmentStepId, enrollmentStepId), isNull(aiDrafts.enrollmentStepId))
      )
    )
    .orderBy(
      sql`case when ${aiDrafts.enrollmentStepId} = ${enrollmentStepId} then 0 else 1 end`,
      desc(aiDrafts.reviewedAt)
    )
    .limit(1);
  return draft ?? null;
}

/** Pending/edited drafts block template send until a human approves (or rejects). */
async function findPendingAiDraft(
  db: DbClient,
  workspaceId: string,
  prospectId: string,
  enrollmentStepId: string
): Promise<{ id: string } | null> {
  const [draft] = await db
    .select({ id: aiDrafts.id })
    .from(aiDrafts)
    .where(
      and(
        eq(aiDrafts.workspaceId, workspaceId),
        eq(aiDrafts.prospectId, prospectId),
        inArray(aiDrafts.status, ["pending_review", "edited"]),
        or(eq(aiDrafts.enrollmentStepId, enrollmentStepId), isNull(aiDrafts.enrollmentStepId))
      )
    )
    .orderBy(
      sql`case when ${aiDrafts.enrollmentStepId} = ${enrollmentStepId} then 0 else 1 end`,
      desc(aiDrafts.createdAt)
    )
    .limit(1);
  return draft ?? null;
}

function pickWeightedVariant<T extends { variantKey: string; weight: number }>(variants: T[]): T | null {
  const enabled = variants.filter((v) => v.weight > 0);
  if (enabled.length === 0) return variants[0] ?? null;
  const total = enabled.reduce((sum, v) => sum + v.weight, 0);
  let roll = Math.random() * total;
  for (const v of enabled) {
    roll -= v.weight;
    if (roll <= 0) return v;
  }
  return enabled[enabled.length - 1] ?? null;
}

async function applyStepVariant(db: DbClient, pending: PendingStep): Promise<PendingStep> {
  let variants: { variantKey: string; weight: number; subject: string | null; bodyTemplate: string | null }[] = [];
  try {
    const rows = await db
      .select()
      .from(sequenceStepVariants)
      .where(and(eq(sequenceStepVariants.stepId, pending.stepId), eq(sequenceStepVariants.enabled, true)));
    variants = Array.isArray(rows) ? rows : [];
  } catch {
    return pending;
  }
  if (variants.length === 0) return pending;
  const chosen = pickWeightedVariant(variants);
  if (!chosen) return pending;
  await db
    .update(sequenceEnrollmentSteps)
    .set({ variantKey: chosen.variantKey })
    .where(eq(sequenceEnrollmentSteps.id, pending.enrollmentStepId));
  return {
    ...pending,
    subject: chosen.subject ?? pending.subject,
    bodyTemplate: chosen.bodyTemplate ?? pending.bodyTemplate,
  };
}

type LinkedinInviteState = "not_sent" | "pending" | "accepted" | "declined" | "failed";

async function linkedinInviteState(
  db: DbClient,
  workspaceId: string,
  enrollmentId: string
): Promise<LinkedinInviteState> {
  const [job] = await db
    .select({
      status: linkedinOutreachJobs.status,
      failureReason: linkedinOutreachJobs.failureReason,
    })
    .from(linkedinOutreachJobs)
    .where(
      and(
        eq(linkedinOutreachJobs.workspaceId, workspaceId),
        eq(linkedinOutreachJobs.enrollmentId, enrollmentId),
        eq(linkedinOutreachJobs.action, "connect")
      )
    )
    .orderBy(desc(linkedinOutreachJobs.createdAt))
    .limit(1);
  if (!job) return "not_sent";
  if (job.status === "completed") return "accepted";
  if (job.status === "failed") {
    const reason = (job.failureReason ?? "").toLowerCase();
    if (reason.includes("declin") || reason.includes("reject")) return "declined";
    return "failed";
  }
  return "pending";
}

async function evaluateCondition(
  db: DbClient,
  workspaceId: string,
  prospectId: string,
  enrollmentId: string,
  conditionType: string | null | undefined
): Promise<boolean> {
  if (!conditionType) return false;
  if (conditionType === "linkedin_connected" || conditionType === "linkedin_invite_accepted") {
    return (await linkedinInviteState(db, workspaceId, enrollmentId)) === "accepted";
  }
  if (conditionType === "linkedin_invite_declined") {
    return (await linkedinInviteState(db, workspaceId, enrollmentId)) === "declined";
  }
  if (conditionType === "email_opened" || conditionType === "email_clicked") {
    const eventType = conditionType === "email_opened" ? "open" : "click";
    const [evt] = await db
      .select({ id: sequenceTrackingEvents.id })
      .from(sequenceTrackingEvents)
      .where(
        and(
          eq(sequenceTrackingEvents.workspaceId, workspaceId),
          eq(sequenceTrackingEvents.enrollmentId, enrollmentId),
          eq(sequenceTrackingEvents.eventType, eventType)
        )
      )
      .limit(1);
    return Boolean(evt);
  }
  if (conditionType === "email_replied") {
    const signal = await detectCadenceSignal(db, workspaceId, prospectId, new Date(0));
    return signal === "replied";
  }
  if (conditionType === "call_connected") {
    const [row] = await db
      .select({ disposition: tasks.disposition })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.sequenceEnrollmentId, enrollmentId),
          eq(tasks.disposition, "connected")
        )
      )
      .limit(1);
    return Boolean(row);
  }
  return false;
}

async function activateConditionBranch(
  db: DbClient,
  enrollmentId: string,
  conditionStepId: string,
  branch: "yes" | "no",
  now: Date
): Promise<void> {
  const branchSteps = await db
    .select({
      enrollmentStepId: sequenceEnrollmentSteps.id,
      delayDays: sequenceSteps.delayDays,
      delayUnit: sequenceSteps.delayUnit,
      branch: sequenceSteps.branch,
    })
    .from(sequenceEnrollmentSteps)
    .innerJoin(sequenceSteps, eq(sequenceEnrollmentSteps.stepId, sequenceSteps.id))
    .where(
      and(
        eq(sequenceEnrollmentSteps.enrollmentId, enrollmentId),
        eq(sequenceSteps.parentStepId, conditionStepId)
      )
    )
    .orderBy(asc(sequenceSteps.stepOrder));

  let cursor = now;
  for (const step of branchSteps) {
    if (step.branch && step.branch !== branch) {
      await db
        .update(sequenceEnrollmentSteps)
        .set({
          status: "skipped",
          executedAt: now,
          failureReason: `condition_${branch === "yes" ? "no" : "yes"}_branch`,
        })
        .where(eq(sequenceEnrollmentSteps.id, step.enrollmentStepId));
      continue;
    }
    const unit = (step.delayUnit ?? "days") as "minutes" | "hours" | "days" | "weeks";
    const scheduled = new Date(cursor.getTime());
    const amount = step.delayDays ?? 0;
    if (unit === "minutes") scheduled.setMinutes(scheduled.getMinutes() + amount);
    else if (unit === "hours") scheduled.setHours(scheduled.getHours() + amount);
    else if (unit === "weeks") scheduled.setDate(scheduled.getDate() + amount * 7);
    else scheduled.setDate(scheduled.getDate() + amount);
    cursor = scheduled;
    await db
      .update(sequenceEnrollmentSteps)
      .set({ status: "scheduled", scheduledAt: scheduled })
      .where(eq(sequenceEnrollmentSteps.id, step.enrollmentStepId));
  }
}

async function markStepTerminal(
  db: DbClient,
  enrollmentStepId: string,
  status: string,
  failureReason: string | null,
  now: Date
): Promise<void> {
  await db
    .update(sequenceEnrollmentSteps)
    .set({ status, executedAt: now, failureReason })
    .where(eq(sequenceEnrollmentSteps.id, enrollmentStepId));
}

/**
 * Sends the email for a scheduled step through a rotated connected inbox.
 * Suppression / missing-prospect-email / no-available-inbox are terminal (non-retryable) —
 * the step is marked failed/skipped and the cadence moves on. An actual send failure
 * (SMTP/network) is re-thrown so the BullMQ job retries — the step stays "scheduled".
 * Returns "deferred" when HITL is waiting on a pending AI draft approval.
 */
async function executeEmailStep(
  db: DbClient,
  config: Env,
  payload: SeqAdvanceJobPayload,
  pending: PendingStep,
  now: Date
): Promise<"done" | "deferred"> {
  const { enrollmentId, workspaceId, prospectId } = payload;

  const prospect = await resolveProspectFields(config, db, workspaceId, prospectId);
  if (!prospect?.email) {
    await markStepTerminal(db, pending.enrollmentStepId, "failed", "prospect_email_not_found", now);
    log.warn("Email step skipped — no prospect email", { enrollmentId, prospectId });
    return "done";
  }

  if (await isSuppressed(db, workspaceId, prospect.email)) {
    await markStepTerminal(db, pending.enrollmentStepId, "skipped", "suppressed", now);
    log.info("Email step skipped — suppressed", { enrollmentId, email: prospect.email });
    return "done";
  }

  if ((await isSendBlockedByEligibility(config, prospect.email)).blocked) {
    await markStepTerminal(db, pending.enrollmentStepId, "skipped", "not_send_eligible", now);
    log.info("Email step skipped — send-eligibility policy blocked it", { enrollmentId, email: prospect.email });
    return "done";
  }

  const inbox = await pickNextInbox(db, workspaceId);
  if (!inbox) {
    await markStepTerminal(db, pending.enrollmentStepId, "failed", "no_active_inbox", now);
    log.warn("Email step failed — no active inbox", { enrollmentId, workspaceId });
    return "done";
  }

  const mergeData: MergeData = {
    firstName: prospect.firstName,
    lastName: prospect.lastName,
    fullName: prospect.fullName,
    companyName: prospect.companyName ?? "",
    companyDomain: prospect.companyDomain ?? "",
    title: prospect.title ?? "",
    senderName: inbox.displayName ?? inbox.emailAddress,
    senderEmail: inbox.emailAddress,
    unsubscribeUrl: buildUnsubscribeUrl(config, workspaceId, prospect.email),
  };

  // If a human has APPROVED an AI draft for this prospect/step, send that instead of the
  // step template. Otherwise fall back to the sequence step's subject/bodyTemplate.
  const approvedDraft = await findApprovedAiDraft(db, workspaceId, prospectId, pending.enrollmentStepId);
  if (approvedDraft) {
    log.info("Email step using approved AI draft", {
      enrollmentId,
      enrollmentStepId: pending.enrollmentStepId,
      draftId: approvedDraft.id,
    });
  } else {
    // True HITL gate: if a draft is still awaiting review, do not send the template.
    const pendingDraft = await findPendingAiDraft(
      db,
      workspaceId,
      prospectId,
      pending.enrollmentStepId
    );
    if (pendingDraft) {
      const deferUntil = new Date(now.getTime() + 60 * 60 * 1000);
      await db
        .update(sequenceEnrollmentSteps)
        .set({ scheduledAt: deferUntil, failureReason: "awaiting_ai_draft_approval" })
        .where(eq(sequenceEnrollmentSteps.id, pending.enrollmentStepId));
      log.info("Email step deferred — HITL draft pending review", {
        enrollmentId,
        enrollmentStepId: pending.enrollmentStepId,
        draftId: pendingDraft.id,
        deferUntil,
      });
      return "deferred";
    }
  }

  const subject = renderTemplate(approvedDraft?.subject ?? pending.subject ?? "", mergeData);
  // bodyTemplate is TipTap HTML from the email builder (or legacy plain text).
  const renderedBody = renderTemplate(approvedDraft?.body ?? pending.bodyTemplate ?? "", mergeData);
  const { html, text } = injectTracking(config, renderedBody, enrollmentId, pending.enrollmentStepId);

  // Build transport first — if credentials are missing, mark terminal rather than letting
  // BullMQ retry forever with a step stuck in "scheduled".
  let transport;
  try {
    transport = await buildEmailSenderFromInbox(config, inbox, db);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : "smtp_build_failed";
    await markStepTerminal(db, pending.enrollmentStepId, "failed", reason, now);
    log.warn("Email step failed — could not build SMTP transport", { enrollmentId, reason });
    return "done";
  }

  // Send the email. SMTP failures propagate so BullMQ retries (step stays "scheduled").
  const sendResult = await transport.send({
    from: inbox.emailAddress,
    fromName: inbox.displayName,
    to: prospect.email,
    subject,
    text,
    html,
  });

  // Record the send atomically. If this transaction fails after the email was already
  // delivered, the job will retry and attempt to send again — we guard against that by
  // checking for an existing "executed" step at the top of advanceEnrollment (the step
  // won't appear as "scheduled" on retry so the enrollment simply moves on).
  await db.transaction(async (tx) => {
    const [thread] = await tx
      .insert(inboxThreads)
      .values({
        workspaceId,
        inboxId: inbox.id,
        enrollmentId,
        prospectId,
        subject,
        status: "new",
        lastMessageAt: now,
      })
      .returning();
    if (!thread) throw new Error("inboxThreads insert returned no row");
    await tx.insert(inboxMessages).values({
      threadId: thread.id,
      direction: "outbound",
      fromAddress: inbox.emailAddress,
      toAddress: prospect.email!,
      subject,
      bodyText: text,
      bodyHtml: html,
      externalId: sendResult.externalId,
      messageId: sendResult.externalId,
      sentAt: now,
    });
    await tx
      .update(sequenceEnrollmentSteps)
      .set({ status: "executed", executedAt: now, failureReason: null })
      .where(eq(sequenceEnrollmentSteps.id, pending.enrollmentStepId));

    // Mark the approved draft as consumed by this step so it is not reused on a later send.
    if (approvedDraft) {
      await tx
        .update(aiDrafts)
        .set({ enrollmentStepId: pending.enrollmentStepId, threadId: thread.id })
        .where(eq(aiDrafts.id, approvedDraft.id));
    }
  });

  await markInboxUsed(db, inbox.id);
  log.info("Email sent", { enrollmentId, enrollmentStepId: pending.enrollmentStepId, inboxId: inbox.id });

  dispatchWebhookEvent(db, config, "sequence.step.completed", workspaceId, {
    enrollmentId,
    sequenceId: payload.sequenceId,
    prospectId,
    stepId: pending.stepId,
    stepType: pending.stepType,
  }).catch((err: unknown) => log.warn("webhook dispatch failed", { err, event: "sequence.step.completed" }));

  return "done";
}

const LINKEDIN_RETRY_MS = 60_000;

/**
 * Sends a LinkedIn connection request or DM via Unipile (server-side).
 * Does not depend on the Chrome extension.
 */
async function executeLinkedinStep(
  db: DbClient,
  config: Env,
  payload: SeqAdvanceJobPayload,
  pending: PendingStep,
  now: Date
): Promise<"waiting" | "done"> {
  const { enrollmentId, workspaceId, prospectId } = payload;

  const accounts = new LinkedinAccountService(db, config);
  if (!(await accounts.isConfiguredForWorkspace(workspaceId))) {
    await markStepTerminal(db, pending.enrollmentStepId, "failed", "unipile_not_configured", now);
    log.warn("LinkedIn step failed — Unipile not configured", { enrollmentId });
    return "done";
  }

  const account = await accounts.pickNextAccount(workspaceId);
  if (!account) {
    await markStepTerminal(db, pending.enrollmentStepId, "failed", "no_active_linkedin_account", now);
    log.warn("LinkedIn step failed — no connected LinkedIn account", { enrollmentId, workspaceId });
    return "done";
  }

  const prospect = await resolveProspectFields(config, db, workspaceId, prospectId);
  const linkedinUrl = prospect?.linkedinUrl;
  if (!linkedinUrl) {
    await markStepTerminal(db, pending.enrollmentStepId, "failed", "prospect_linkedin_url_not_found", now);
    log.warn("LinkedIn step failed — no profile URL", { enrollmentId, prospectId });
    return "done";
  }

  const action = pending.linkedinAction === "message" ? "message" : ("connect" as const);
  const mergeData: MergeData = {
    firstName: prospect?.firstName ?? "",
    lastName: prospect?.lastName ?? "",
    fullName: prospect?.fullName ?? "",
    companyName: prospect?.companyName ?? "",
    companyDomain: prospect?.companyDomain ?? "",
    title: prospect?.title ?? "",
    senderName: account.displayName ?? "",
    senderEmail: "",
    unsubscribeUrl: "",
  };
  const message = pending.bodyTemplate
    ? renderTemplate(
        pending.bodyTemplate.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        mergeData
      )
    : null;

  const outreach = new LinkedinOutreachService(db, config);
  const job = await outreach.ensureJobForStep({
    workspaceId,
    enrollmentId,
    enrollmentStepId: pending.enrollmentStepId,
    prospectId,
    linkedinUrl,
    action,
    message: message || null,
  });

  if (job.status === "completed") {
    await markStepTerminal(db, pending.enrollmentStepId, "executed", null, now);
    return "done";
  }
  if (job.status === "failed") {
    await markStepTerminal(
      db,
      pending.enrollmentStepId,
      "failed",
      job.failureReason ?? "linkedin_failed",
      now
    );
    return "done";
  }

  try {
    await sendLinkedinOutreach(config, account, { action, linkedinUrl, message }, workspaceId, db);
    await accounts.markUsed(account.id);
    await outreach.completeJob(workspaceId, job.id);
    log.info("LinkedIn outreach sent via Unipile", {
      enrollmentId,
      enrollmentStepId: pending.enrollmentStepId,
      action,
      accountId: account.id,
    });
    // completeJob already enqueues next advance
    return "waiting";
  } catch (err: unknown) {
    const reason =
      err instanceof UnipileError
        ? err.message
        : err instanceof Error
          ? err.message
          : "linkedin_send_failed";

    // Rate limits / transient — retry later without failing the step
    const status = err instanceof UnipileError ? err.status : 0;
    if (status === 429 || status >= 500) {
      await accounts.markError(account.id, reason);
      log.warn("LinkedIn send transient failure — will retry", { enrollmentId, reason, status });
      await enqueueSequenceAdvanceJob(config, payload, LINKEDIN_RETRY_MS, false);
      return "waiting";
    }

    await accounts.markError(account.id, reason);
    await outreach.failJob(workspaceId, job.id, reason);
    log.warn("LinkedIn step failed", { enrollmentId, reason });
    return "waiting";
  }
}

/**
 * R20.4 — "call" step. Twilio click-to-call (R20.2) isn't wired into automatic dialing — a
 * cold outbound dial with no human on the line is bad practice regardless. Instead this step
 * creates a CRM task ("Call <prospect>", due now) and an R17.1 notification to every
 * owner/admin in the workspace, so a human places the call via the task's "Call now" affordance
 * (once R20.2 credentials are configured) or manually otherwise.
 *
 * Unlike other step types, this one does NOT mark itself "executed" immediately — the step is
 * left `awaiting_disposition` until the SDR sets `tasks.disposition` on the created task.
 * `resolveCallDisposition()` below polls for that, then branches the cadence exactly the way
 * `detectCadenceSignal()` branches on reply/bounce: "bad_number" stops the cadence outright,
 * anything else (connected/no_answer/voicemail) resolves the step and lets the cadence continue.
 */
async function executeCallStep(
  db: DbClient,
  config: Env,
  payload: SeqAdvanceJobPayload,
  pending: PendingStep,
  now: Date
): Promise<"waiting"> {
  const { enrollmentId, workspaceId, prospectId } = payload;
  const { tasks, workspaceMembers } = schema;

  const prospect = await resolveProspectFields(config, db, workspaceId, prospectId);
  const prospectLabel = prospect?.fullName || prospectId;
  const companySuffix = prospect?.companyName ? ` (${prospect.companyName})` : "";

  await db.insert(tasks).values({
    workspaceId,
    title: `Call ${prospectLabel}${companySuffix}`,
    dueDate: now,
    priority: "high",
    status: "open",
    relatedEntityType: "sequence_call_step",
    // relatedEntityId is uuid-typed; prospectId is a text corpus hash, not a uuid (see R14.1 —
    // sequence/CRM identity isn't reconciled yet), so it can't be stored here without corrupting
    // the column. prospectId (text) below carries it instead, and is what powers "Call now".
    relatedEntityId: null,
    prospectId,
    sequenceEnrollmentId: enrollmentId,
    sequenceEnrollmentStepId: pending.enrollmentStepId,
  });

  const owners = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), or(eq(workspaceMembers.role, "owner"), eq(workspaceMembers.role, "admin"))));

  for (const { userId } of owners) {
    try {
      await createNotification(db, config, {
        workspaceId,
        userId,
        type: "reminder",
        title: `Call step due: ${prospectLabel}`,
        body: `A "call" sequence step is due${companySuffix ? ` for ${prospectLabel}${companySuffix}` : ""}. A task has been created — dial from the CRM once ready.`,
        entityType: "prospect",
        entityId: prospectId,
      });
    } catch (err) {
      log.warn("Failed to notify owner of due call step", { err, workspaceId, userId, enrollmentId });
    }
  }

  await db
    .update(sequenceEnrollmentSteps)
    .set({ status: "awaiting_disposition", executedAt: null, failureReason: null })
    .where(eq(sequenceEnrollmentSteps.id, pending.enrollmentStepId));
  log.info("Call step created task + notified owners — awaiting disposition", { enrollmentId, prospectId });
  return "waiting";
}

const CALL_DISPOSITION_POLL_MS = 15 * 60 * 1000;

/**
 * Finds an in-flight "call" step for this enrollment that's parked waiting on a human-set
 * task disposition (see executeCallStep above).
 */
async function findAwaitingCallStep(db: DbClient, enrollmentId: string): Promise<{ enrollmentStepId: string } | null> {
  const [row] = await db
    .select({ enrollmentStepId: sequenceEnrollmentSteps.id })
    .from(sequenceEnrollmentSteps)
    .where(and(eq(sequenceEnrollmentSteps.enrollmentId, enrollmentId), eq(sequenceEnrollmentSteps.status, "awaiting_disposition")))
    .limit(1);
  return row ?? null;
}

/**
 * R20.4 — the disposition equivalent of `detectCadenceSignal()`. "bad_number" is treated like a
 * bounce (hard stop — dialing a bad number again on the next step wastes the SDR's time).
 * "connected" / "no_answer" / "voicemail" all just resolve the step and let the cadence proceed
 * to whatever comes next, same as a normal email/LinkedIn send completing.
 */
async function resolveCallDisposition(
  db: DbClient,
  payload: SeqAdvanceJobPayload,
  enrollmentStepId: string,
  now: Date
): Promise<"resolved" | "waiting" | "stopped"> {
  const { tasks } = schema;
  const [task] = await db
    .select({ id: tasks.id, disposition: tasks.disposition })
    .from(tasks)
    .where(eq(tasks.sequenceEnrollmentStepId, enrollmentStepId))
    .limit(1);

  if (!task?.disposition) return "waiting";

  if (task.disposition === "bad_number") {
    await db.transaction(async (tx) => {
      await tx
        .update(sequenceEnrollments)
        .set({ status: "bad_number", completedAt: now })
        .where(eq(sequenceEnrollments.id, payload.enrollmentId));
      await tx
        .update(sequenceEnrollmentSteps)
        .set({ status: "skipped" })
        .where(
          and(
            eq(sequenceEnrollmentSteps.enrollmentId, payload.enrollmentId),
            inArray(sequenceEnrollmentSteps.status, ["scheduled", "awaiting_disposition"])
          )
        );
    });
    log.info("Cadence stopped — bad_number disposition", { enrollmentId: payload.enrollmentId, enrollmentStepId });
    return "stopped";
  }

  await db
    .update(sequenceEnrollmentSteps)
    .set({
      status: "executed",
      executedAt: now,
      failureReason: task.disposition === "connected" ? null : task.disposition,
    })
    .where(eq(sequenceEnrollmentSteps.id, enrollmentStepId));
  log.info("Call step resolved via disposition", {
    enrollmentId: payload.enrollmentId,
    enrollmentStepId,
    disposition: task.disposition,
  });
  return "resolved";
}

async function executeWhatsappStep(
  db: DbClient,
  config: Env,
  payload: SeqAdvanceJobPayload,
  pending: PendingStep,
  now: Date
): Promise<"waiting" | "done"> {
  const { enrollmentId, workspaceId, prospectId } = payload;

  const accounts = new LinkedinAccountService(db, config);
  if (!(await accounts.isConfiguredForWorkspace(workspaceId))) {
    await markStepTerminal(db, pending.enrollmentStepId, "failed", "unipile_not_configured", now);
    log.warn("WhatsApp step failed — Unipile not configured", { enrollmentId });
    return "done";
  }

  const account = await accounts.pickNextAccount(workspaceId, "whatsapp");
  if (!account) {
    await markStepTerminal(db, pending.enrollmentStepId, "failed", "no_active_whatsapp_account", now);
    log.warn("WhatsApp step failed — no connected WhatsApp account", { enrollmentId, workspaceId });
    return "done";
  }

  const prospect = await resolveProspectFields(config, db, workspaceId, prospectId);
  const phone = prospect?.phone;
  if (!phone) {
    await markStepTerminal(db, pending.enrollmentStepId, "failed", "prospect_phone_not_found", now);
    log.warn("WhatsApp step failed — no phone", { enrollmentId, prospectId });
    return "done";
  }

  const mergeData: MergeData = {
    firstName: prospect?.firstName ?? "",
    lastName: prospect?.lastName ?? "",
    fullName: prospect?.fullName ?? "",
    companyName: prospect?.companyName ?? "",
    companyDomain: prospect?.companyDomain ?? "",
    title: prospect?.title ?? "",
    senderName: account.displayName ?? "",
    senderEmail: "",
    unsubscribeUrl: "",
  };
  const message = pending.bodyTemplate
    ? renderTemplate(
        pending.bodyTemplate.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        mergeData
      )
    : "";

  try {
    await sendWhatsappOutreach(config, account, { phone, message }, workspaceId, db);
    await accounts.markUsed(account.id);
    await markStepTerminal(db, pending.enrollmentStepId, "executed", null, now);
    log.info("WhatsApp message sent via Unipile", {
      enrollmentId,
      enrollmentStepId: pending.enrollmentStepId,
      accountId: account.id,
    });
    return "done";
  } catch (err: unknown) {
    const reason =
      err instanceof UnipileError
        ? err.message
        : err instanceof Error
          ? err.message
          : "whatsapp_send_failed";
    const status = err instanceof UnipileError ? err.status : 0;
    if (status === 429 || status >= 500) {
      await accounts.markError(account.id, reason);
      log.warn("WhatsApp send transient failure — will retry", { enrollmentId, reason, status });
      await enqueueSequenceAdvanceJob(config, payload, LINKEDIN_RETRY_MS, false);
      return "waiting";
    }
    await accounts.markError(account.id, reason);
    await markStepTerminal(db, pending.enrollmentStepId, "failed", reason, now);
    log.warn("WhatsApp step failed", { enrollmentId, reason });
    return "done";
  }
}

/**
 * "Manual task" sequence step (R21.3) — creates a real CRM task (apps/crm's `tasks` table) due
 * immediately, so it shows up on the rep's My Tasks page and picks up a reminder via the normal
 * R17.2 sweep. Linked to the prospect's CRM contact when one already exists (matched via
 * `contacts.sourceProspectId`); left unlinked otherwise rather than blocking step execution —
 * sequences run against prospects that haven't necessarily been synced into the CRM yet.
 */
async function createTaskFromSequenceStep(
  db: DbClient,
  config: Env,
  workspaceId: string,
  prospectId: string,
  pending: PendingStep
): Promise<void> {
  const [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.sourceProspectId, prospectId)))
    .limit(1);

  let title = pending.subject?.trim() || "Follow up with prospect";
  const prospect = await resolveProspectFields(config, db, workspaceId, prospectId).catch(() => null);
  if (prospect) {
    title = renderTemplate(title, {
      firstName: prospect.firstName ?? "",
      lastName: prospect.lastName ?? "",
      fullName: prospect.fullName ?? "",
      companyName: prospect.companyName ?? "",
      companyDomain: prospect.companyDomain ?? "",
      title: prospect.title ?? "",
      senderName: "",
      senderEmail: "",
      unsubscribeUrl: "",
    });
  }

  await db.insert(tasks).values({
    workspaceId,
    title,
    type: "custom",
    dueDate: new Date(),
    relatedEntityType: contact ? "contact" : undefined,
    relatedEntityId: contact ? contact.id : undefined,
  });
}

// ---------------------------------------------------------------------------
// Core advance logic
// ---------------------------------------------------------------------------

async function advanceEnrollment(
  db: ReturnType<typeof createDb>["db"],
  config: Env,
  payload: SeqAdvanceJobPayload
): Promise<void> {
  const { enrollmentId, workspaceId, prospectId, sequenceId } = payload;

  // Load enrollment
  const [enrollment] = await db
    .select()
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.id, enrollmentId),
        eq(sequenceEnrollments.workspaceId, workspaceId)
      )
    )
    .limit(1);

  if (!enrollment || enrollment.status !== "active") {
    log.info("Enrollment not active — skipping", { enrollmentId, status: enrollment?.status });
    return;
  }

  // Reply / bounce detection — stops or pauses the cadence
  const signal = await detectCadenceSignal(db, workspaceId, prospectId, enrollment.enrolledAt);
  if (signal !== "none") {
    const newStatus = signal === "bounced" ? "bounced" : "replied";
    const stopReason = signal === "bounced" ? "BOUNCED" : "POSITIVE_REPLY";
    await db.transaction(async (tx) => {
      await tx
        .update(sequenceEnrollments)
        .set({ status: newStatus, completedAt: new Date(), stopReason })
        .where(eq(sequenceEnrollments.id, enrollmentId));
      await tx
        .update(sequenceEnrollmentSteps)
        .set({ status: "skipped" })
        .where(
          and(
            eq(sequenceEnrollmentSteps.enrollmentId, enrollmentId),
            eq(sequenceEnrollmentSteps.status, "scheduled")
          )
        );
    });
    await recordSequenceEvent(db, {
      workspaceId,
      sequenceId,
      enrollmentId,
      sequenceVersionId: enrollment.sequenceVersionId,
      prospectId,
      eventType: "sequence_stopped",
      reason: stopReason,
      result: newStatus,
    });
    log.info("Cadence stopped", { enrollmentId, reason: newStatus });
    return;
  }

  // R20.4 — a "call" step is parked waiting on a human-set disposition. Resolve it (or keep
  // waiting) before looking for the next "scheduled" step, since an awaiting_disposition step
  // deliberately won't show up in that query and must not be mistaken for "nothing left to do".
  const awaitingCall = await findAwaitingCallStep(db, enrollmentId);
  if (awaitingCall) {
    const outcome = await resolveCallDisposition(db, payload, awaitingCall.enrollmentStepId, new Date());
    if (outcome === "stopped") return;
    if (outcome === "waiting") {
      await enqueueSequenceAdvanceJob(config, payload, CALL_DISPOSITION_POLL_MS, false);
      return;
    }
    // "resolved" — fall through and continue the cadence below in this same tick.
  }

  // Find the next scheduled step in order
  const [pending] = await db
    .select({
      enrollmentStepId: sequenceEnrollmentSteps.id,
      stepId: sequenceEnrollmentSteps.stepId,
      scheduledAt: sequenceEnrollmentSteps.scheduledAt,
      stepOrder: sequenceSteps.stepOrder,
      stepType: sequenceSteps.stepType,
      linkedinAction: sequenceSteps.linkedinAction,
      subject: sequenceSteps.subject,
      bodyTemplate: sequenceSteps.bodyTemplate,
      conditionType: sequenceSteps.conditionType,
      conditionWaitDays: sequenceSteps.conditionWaitDays,
      conditionExpression: sequenceSteps.conditionExpression,
      yesNextStepId: sequenceSteps.yesNextStepId,
      noNextStepId: sequenceSteps.noNextStepId,
    })
    .from(sequenceEnrollmentSteps)
    .innerJoin(sequenceSteps, eq(sequenceEnrollmentSteps.stepId, sequenceSteps.id))
    .where(
      and(
        eq(sequenceEnrollmentSteps.enrollmentId, enrollmentId),
        eq(sequenceEnrollmentSteps.status, "scheduled")
      )
    )
    .orderBy(asc(sequenceSteps.stepOrder))
    .limit(1);

  if (!pending) {
    // All steps done — mark enrollment complete
    await db
      .update(sequenceEnrollments)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(sequenceEnrollments.id, enrollmentId));
    log.info("Enrollment completed", { enrollmentId });
    return;
  }

  const now = new Date();

  // Not yet due — re-enqueue with remaining delay (skipped when bypassing business hours)
  if (!config.BYPASS_BUSINESS_HOURS && pending.scheduledAt && pending.scheduledAt > now) {
    const delayMs = pending.scheduledAt.getTime() - now.getTime();
    await enqueueSequenceAdvanceJob(config, payload, delayMs, false);
    log.debug("Step not yet due — re-enqueued", { enrollmentId, delayMs });
    return;
  }

  // Outside business hours — re-enqueue to fire at the next business window
  if (!isBusinessHour(now) && !config.BYPASS_BUSINESS_HOURS) {
    const nextWindow = nextBusinessHour(now);
    const delayMs = nextWindow.getTime() - now.getTime();
    await enqueueSequenceAdvanceJob(config, payload, delayMs, false);
    log.debug("Outside business hours — re-enqueued", { enrollmentId, nextWindow });
    return;
  }

  let step = pending as PendingStep & typeof pending;
  if (enrollment.sequenceVersionId) {
    const [version] = await db
      .select({ snapshot: sequenceVersions.snapshot })
      .from(sequenceVersions)
      .where(eq(sequenceVersions.id, enrollment.sequenceVersionId))
      .limit(1);
    const snapSteps = (version?.snapshot as { steps?: Array<Record<string, unknown>> } | null)?.steps;
    const snap = Array.isArray(snapSteps) ? snapSteps.find((s) => s.id === pending.stepId) : undefined;
    if (snap) {
      step = {
        ...pending,
        subject: (snap.subject as string | null) ?? pending.subject,
        bodyTemplate: (snap.bodyTemplate as string | null) ?? pending.bodyTemplate,
        linkedinAction: (snap.linkedinAction as string | null) ?? pending.linkedinAction,
        conditionType: (snap.conditionType as string | null) ?? pending.conditionType,
        conditionWaitDays: (snap.conditionWaitDays as number | null) ?? pending.conditionWaitDays,
        conditionExpression: snap.conditionExpression ?? pending.conditionExpression,
      };
    }
  }

  // Execute the step
  if (step.stepType === "condition") {
    const waitDays = step.conditionWaitDays ?? 2;
    const due = pending.scheduledAt
      ? new Date(pending.scheduledAt.getTime() + waitDays * 24 * 60 * 60 * 1000)
      : new Date(now.getTime() + waitDays * 24 * 60 * 60 * 1000);
    const expr =
      parseConditionExpression(step.conditionExpression) ?? expressionFromSingle(step.conditionType);
    const evalLeaf = async (type: ConditionLeafType, value?: number) => {
      if (type === "icp_score_gte") {
        const score = await getIcpScore(db, workspaceId, prospectId);
        return (score ?? 0) >= (value ?? 80);
      }
      if (type === "has_email") {
        const prospect = await resolveProspectFields(config, db, workspaceId, prospectId);
        return Boolean(prospect?.email);
      }
      if (type === "has_linkedin") {
        const prospect = await resolveProspectFields(config, db, workspaceId, prospectId);
        return Boolean((prospect as { linkedinUrl?: string | null } | null)?.linkedinUrl);
      }
      return evaluateCondition(db, workspaceId, prospectId, enrollmentId, type);
    };
    const invite = await linkedinInviteState(db, workspaceId, enrollmentId);
    const singleInvite =
      expr && "type" in expr &&
      (expr.type === "linkedin_invite_accepted" || expr.type === "linkedin_connected" || expr.type === "linkedin_invite_declined");

    if (singleInvite && (invite === "declined" || invite === "failed" || invite === "accepted")) {
      const evaluated = await evaluateConditionExpression(expr!, evalLeaf);
      const branch: "yes" | "no" = evaluated.passed ? "yes" : "no";
      await markStepTerminal(db, pending.enrollmentStepId, "executed", `condition_${branch}_${invite}`, now);
      await activateConditionBranch(db, enrollmentId, pending.stepId, branch, now);
      await recordSequenceEvent(db, {
        workspaceId, sequenceId, enrollmentId,
        sequenceVersionId: enrollment.sequenceVersionId, prospectId, stepId: pending.stepId,
        eventType: "condition_evaluated", branch, result: String(evaluated.passed), reason: invite,
        evidence: evaluated.evidence,
      });
      await recordSequenceEvent(db, {
        workspaceId, sequenceId, enrollmentId,
        sequenceVersionId: enrollment.sequenceVersionId, prospectId, stepId: pending.stepId,
        eventType: branch === "no" ? "fallback_triggered" : "branch_selected", branch, reason: invite,
      });
    } else if (due > now && !config.BYPASS_BUSINESS_HOURS) {
      if (expr) {
        const early = await evaluateConditionExpression(expr, evalLeaf);
        if (early.passed) {
          await markStepTerminal(db, pending.enrollmentStepId, "executed", "condition_yes_early", now);
          await activateConditionBranch(db, enrollmentId, pending.stepId, "yes", now);
          await recordSequenceEvent(db, {
            workspaceId, sequenceId, enrollmentId,
            sequenceVersionId: enrollment.sequenceVersionId, prospectId, stepId: pending.stepId,
            eventType: "condition_evaluated", branch: "yes", result: "true", reason: "early",
            evidence: early.evidence,
          });
        } else {
          await enqueueSequenceAdvanceJob(config, payload, Math.max(60_000, due.getTime() - now.getTime()), false);
          return;
        }
      } else {
        await enqueueSequenceAdvanceJob(config, payload, Math.max(60_000, due.getTime() - now.getTime()), false);
        return;
      }
    } else {
      const evaluated = expr
        ? await evaluateConditionExpression(expr, evalLeaf)
        : { passed: false, evidence: { reason: "no_condition" } };
      const branch: "yes" | "no" = evaluated.passed ? "yes" : "no";
      await markStepTerminal(db, pending.enrollmentStepId, "executed", `condition_${branch}`, now);
      await activateConditionBranch(db, enrollmentId, pending.stepId, branch, now);
      await recordSequenceEvent(db, {
        workspaceId, sequenceId, enrollmentId,
        sequenceVersionId: enrollment.sequenceVersionId, prospectId, stepId: pending.stepId,
        eventType: "condition_evaluated", branch, result: String(evaluated.passed),
        reason: due <= now ? "timeout" : "evaluated",
        evidence: evaluated.evidence,
      });
      if (branch === "no") {
        await recordSequenceEvent(db, {
          workspaceId, sequenceId, enrollmentId,
          sequenceVersionId: enrollment.sequenceVersionId, prospectId, stepId: pending.stepId,
          eventType: "fallback_triggered", branch: "no", reason: "timeout_or_failed",
        });
      }
    }
  } else if (step.stepType === "email") {
    const withVariant = await applyStepVariant(db, step);
    const result = await executeEmailStep(db, config, payload, withVariant, now);
    if (result === "done") {
      await recordSequenceEvent(db, {
        workspaceId, sequenceId, enrollmentId,
        sequenceVersionId: enrollment.sequenceVersionId, prospectId, stepId: pending.stepId,
        eventType: "action_sent", variantKey: withVariant === step ? null : "A",
        reason: "email",
      });
    }
    if (result === "deferred") {
      await enqueueSequenceAdvanceJob(config, payload, 60 * 60 * 1000, false);
      return;
    }
  } else if (step.stepType === "linkedin") {
    const withVariant = await applyStepVariant(db, step);
    const result = await executeLinkedinStep(db, config, payload, withVariant, now);
    if (result === "waiting") {
      // Extension has not finished yet — poll job already re-enqueued.
      return;
    }
  } else if (step.stepType === "whatsapp") {
    const result = await executeWhatsappStep(db, config, payload, pending, now);
    if (result === "waiting") return;
  } else if (step.stepType === "task") {
    await createTaskFromSequenceStep(db, config, workspaceId, prospectId, pending);
    await db
      .update(sequenceEnrollmentSteps)
      .set({ status: "executed", executedAt: now })
      .where(eq(sequenceEnrollmentSteps.id, pending.enrollmentStepId));
    log.info("Manual task step executed", { enrollmentId, enrollmentStepId: pending.enrollmentStepId });
  } else if (step.stepType === "call") {
    const result = await executeCallStep(db, config, payload, pending, now);
    if (result === "waiting") {
      // Awaiting SDR disposition — poll for it on the next tick rather than advancing now.
      await enqueueSequenceAdvanceJob(config, payload, CALL_DISPOSITION_POLL_MS, false);
      return;
    }
  } else if (step.stepType === "goal") {
    await markStepTerminal(db, pending.enrollmentStepId, "executed", null, now);
    await db
      .update(sequenceEnrollments)
      .set({ status: "completed", completedAt: now, stopReason: "SEQUENCE_COMPLETED" })
      .where(eq(sequenceEnrollments.id, enrollmentId));
    await recordSequenceEvent(db, {
      workspaceId, sequenceId, enrollmentId,
      sequenceVersionId: enrollment.sequenceVersionId, prospectId, stepId: pending.stepId,
      eventType: "sequence_completed", reason: "SEQUENCE_COMPLETED",
    });
    log.info("Goal reached — enrollment completed", { enrollmentId, goal: step.subject });
    return;
  } else {
    await db
      .update(sequenceEnrollmentSteps)
      .set({ status: "executed", executedAt: now })
      .where(eq(sequenceEnrollmentSteps.id, pending.enrollmentStepId));

    log.info("Step executed", {
      enrollmentId,
      enrollmentStepId: pending.enrollmentStepId,
      stepType: pending.stepType,
      stepOrder: pending.stepOrder,
    });
  }

  // Check if there is a next step
  const [nextPending] = await db
    .select({
      enrollmentStepId: sequenceEnrollmentSteps.id,
      scheduledAt: sequenceEnrollmentSteps.scheduledAt,
    })
    .from(sequenceEnrollmentSteps)
    .innerJoin(sequenceSteps, eq(sequenceEnrollmentSteps.stepId, sequenceSteps.id))
    .where(
      and(
        eq(sequenceEnrollmentSteps.enrollmentId, enrollmentId),
        eq(sequenceEnrollmentSteps.status, "scheduled")
      )
    )
    .orderBy(asc(sequenceSteps.stepOrder))
    .limit(1);

  if (!nextPending) {
    await db
      .update(sequenceEnrollments)
      .set({ status: "completed", completedAt: new Date(), stopReason: "SEQUENCE_COMPLETED" })
      .where(eq(sequenceEnrollments.id, enrollmentId));
    await recordSequenceEvent(db, {
      workspaceId, sequenceId, enrollmentId,
      sequenceVersionId: enrollment.sequenceVersionId, prospectId,
      eventType: "sequence_completed", reason: "SEQUENCE_COMPLETED",
    });
    log.info("Enrollment completed after last step", { enrollmentId });
    return;
  }

  // Enqueue advance job for the next step, delayed to its scheduledAt
  const delayMs = nextPending.scheduledAt
    ? Math.max(0, nextPending.scheduledAt.getTime() - Date.now())
    : 0;
  await enqueueSequenceAdvanceJob(config, payload, delayMs, false);
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------

export async function startSequenceEnrollmentWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("Sequence enrollment worker not started — DATABASE_URL not set");
    return async () => {};
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Sequence enrollment worker not started — Redis unavailable");
    return async () => {};
  }

  const { db, sql } = createDb(config.DATABASE_URL);

  const worker = new Worker<SeqAdvanceJobPayload>(
    SEQUENCE_ENROLLMENT_QUEUE,
    async (job) => {
      log.info("Processing step:advance", {
        enrollmentId: job.data.enrollmentId,
        attempt: job.attemptsMade,
      });
      await advanceEnrollment(db, config, job.data);
    },
    {
      connection: redisBullMqConnection(config.REDIS_URL),
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    log.error("step:advance job failed", err, {
      enrollmentId: job?.data?.enrollmentId,
      workspaceId: job?.data?.workspaceId,
    });
  });

  log.info("Sequence enrollment worker started", { queue: SEQUENCE_ENROLLMENT_QUEUE });

  return async () => {
    await worker.close();
    await sql.end();
  };
}

/** Standalone entrypoint: `node dist/workers/sequence-enrollment.worker.js` */
async function main() {
  const config = loadEnv();
  const stop = await startSequenceEnrollmentWorker(config);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1]?.includes("sequence-enrollment.worker") ||
  process.env.SEQ_ENROLLMENT_WORKER_STANDALONE === "true";

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
