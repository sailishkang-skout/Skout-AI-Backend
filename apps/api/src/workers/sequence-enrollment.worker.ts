import { Worker } from "bullmq";
import { and, asc, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
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

const log = createLogger("sequence-enrollment.worker");

const {
  sequenceEnrollments,
  sequenceEnrollmentSteps,
  sequenceSteps,
  inboxThreads,
  inboxMessages,
  aiDrafts,
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
 */
async function executeEmailStep(
  db: DbClient,
  config: Env,
  payload: SeqAdvanceJobPayload,
  pending: PendingStep,
  now: Date
): Promise<void> {
  const { enrollmentId, workspaceId, prospectId } = payload;

  const prospect = await resolveProspectFields(config, db, workspaceId, prospectId);
  if (!prospect?.email) {
    await markStepTerminal(db, pending.enrollmentStepId, "failed", "prospect_email_not_found", now);
    log.warn("Email step skipped — no prospect email", { enrollmentId, prospectId });
    return;
  }

  if (await isSuppressed(db, workspaceId, prospect.email)) {
    await markStepTerminal(db, pending.enrollmentStepId, "skipped", "suppressed", now);
    log.info("Email step skipped — suppressed", { enrollmentId, email: prospect.email });
    return;
  }

  const inbox = await pickNextInbox(db, workspaceId);
  if (!inbox) {
    await markStepTerminal(db, pending.enrollmentStepId, "failed", "no_active_inbox", now);
    log.warn("Email step failed — no active inbox", { enrollmentId, workspaceId });
    return;
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
  }

  const subject = renderTemplate(approvedDraft?.subject ?? pending.subject ?? "", mergeData);
  // bodyTemplate is TipTap HTML from the email builder (or legacy plain text).
  const renderedBody = renderTemplate(approvedDraft?.body ?? pending.bodyTemplate ?? "", mergeData);
  const { html, text } = injectTracking(config, renderedBody, enrollmentId, pending.enrollmentStepId);

  // Build transport first — if credentials are missing, mark terminal rather than letting
  // BullMQ retry forever with a step stuck in "scheduled".
  let transport;
  try {
    transport = buildEmailSenderFromInbox(config, inbox);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : "smtp_build_failed";
    await markStepTerminal(db, pending.enrollmentStepId, "failed", reason, now);
    log.warn("Email step failed — could not build SMTP transport", { enrollmentId, reason });
    return;
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
      .set({ status: "executed", executedAt: now })
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
    await db.transaction(async (tx) => {
      await tx
        .update(sequenceEnrollments)
        .set({ status: newStatus, completedAt: new Date() })
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
    log.info("Cadence stopped", { enrollmentId, reason: newStatus });
    return;
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

  // Execute the step
  if (pending.stepType === "email") {
    await executeEmailStep(db, config, payload, pending, now);
  } else if (pending.stepType === "linkedin") {
    const result = await executeLinkedinStep(db, config, payload, pending, now);
    if (result === "waiting") {
      // Extension has not finished yet — poll job already re-enqueued.
      return;
    }
  } else if (pending.stepType === "whatsapp") {
    const result = await executeWhatsappStep(db, config, payload, pending, now);
    if (result === "waiting") return;
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
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(sequenceEnrollments.id, enrollmentId));
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
