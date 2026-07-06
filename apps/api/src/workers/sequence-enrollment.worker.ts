import { Worker } from "bullmq";
import { and, asc, eq, gte } from "drizzle-orm";
import { createDb } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
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

const log = createLogger("sequence-enrollment.worker");

const {
  sequenceEnrollments,
  sequenceEnrollmentSteps,
  sequenceSteps,
  inboxThreads,
  inboxMessages,
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
  // Hard stop: bounced thread
  const [bounced] = await db
    .select({ id: inboxThreads.id })
    .from(inboxThreads)
    .where(
      and(
        eq(inboxThreads.workspaceId, workspaceId),
        eq(inboxThreads.prospectId, prospectId),
        eq(inboxThreads.status, "bounced")
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
  subject: string | null;
  bodyTemplate: string | null;
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

  const subject = renderTemplate(pending.subject ?? "", mergeData);
  const bodyText = renderTemplate(pending.bodyTemplate ?? "", mergeData);
  const { html, text } = injectTracking(config, bodyText, enrollmentId, pending.enrollmentStepId);

  // Transport failures propagate — the job retries with the step still "scheduled".
  const transport = buildEmailSenderFromInbox(config, inbox);
  const sendResult = await transport.send({
    from: inbox.emailAddress,
    fromName: inbox.displayName,
    to: prospect.email,
    subject,
    text,
    html,
  });

  await db.transaction(async (tx) => {
    const [thread] = await tx
      .insert(inboxThreads)
      .values({
        workspaceId,
        inboxId: inbox.id,
        enrollmentId,
        prospectId,
        subject,
        status: "open",
        lastMessageAt: now,
      })
      .returning();
    await tx.insert(inboxMessages).values({
      threadId: thread!.id,
      direction: "outbound",
      fromAddress: inbox.emailAddress,
      toAddress: prospect.email!,
      subject,
      bodyText: text,
      bodyHtml: html,
      externalId: sendResult.externalId,
      // RFC 5322 Message-ID from nodemailer (same value, stored for thread matching)
      messageId: sendResult.externalId,
      sentAt: now,
    });
    await tx
      .update(sequenceEnrollmentSteps)
      .set({ status: "executed", executedAt: now })
      .where(eq(sequenceEnrollmentSteps.id, pending.enrollmentStepId));
  });

  await markInboxUsed(db, inbox.id);
  log.info("Email sent", { enrollmentId, enrollmentStepId: pending.enrollmentStepId, inboxId: inbox.id });
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

  // Not yet due — re-enqueue with remaining delay
  if (pending.scheduledAt && pending.scheduledAt > now) {
    const delayMs = pending.scheduledAt.getTime() - now.getTime();
    await enqueueSequenceAdvanceJob(config, payload, delayMs);
    log.debug("Step not yet due — re-enqueued", { enrollmentId, delayMs });
    return;
  }

  // Outside business hours — re-enqueue to fire at the next business window
  if (!isBusinessHour(now)) {
    const nextWindow = nextBusinessHour(now);
    const delayMs = nextWindow.getTime() - now.getTime();
    await enqueueSequenceAdvanceJob(config, payload, delayMs);
    log.debug("Outside business hours — re-enqueued", { enrollmentId, nextWindow });
    return;
  }

  // Execute the step
  if (pending.stepType === "email") {
    await executeEmailStep(db, config, payload, pending, now);
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
  await enqueueSequenceAdvanceJob(config, payload, delayMs);
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------

function redisConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || "6379"),
    password: parsed.password || undefined,
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export async function startSequenceEnrollmentWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("Sequence enrollment worker not started — DATABASE_URL not set");
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
      connection: redisConnection(config.REDIS_URL),
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
