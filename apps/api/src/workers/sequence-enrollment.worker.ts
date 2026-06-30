import { Worker } from "bullmq";
import { and, asc, eq, gte } from "drizzle-orm";
import { createDb } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isBusinessHour, nextBusinessHour } from "../utils/scheduling.js";
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
