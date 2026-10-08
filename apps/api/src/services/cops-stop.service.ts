import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { writeCopsAudit } from "./cops-platform.service.js";
import { recordSequenceEvent } from "./sequence-events.js";

/**
 * COPS-05 stop conditions for the onboarding follow-up (Bible Appendix C, p.42/74). A stop marks
 * the enrollment terminal and cancels every `scheduled` step in one transaction, with the
 * enrollment row locked; together with claimScheduledStep (sequence-step-claim.ts) no step can
 * start once a stop has committed. Pause keeps the schedule; resume re-queues the next step.
 */
const { sequenceEnrollments, sequenceEnrollmentSteps, copsFollowUps } = schema;

export const STOP_REASONS = [
  "REPLIED",
  "MEETING_BOOKED",
  "ACTIVATED",
  "OPPORTUNITY_CLOSED",
  "OPTED_OUT",
  "HARD_BOUNCE",
  "REP_STOPPED",
  "CRITICAL_ESCALATION",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export type EnrollmentControlError = "NOT_FOUND" | "NOT_ACTIVE" | "NOT_PAUSED";

export class EnrollmentControlFailure extends Error {
  constructor(readonly code: EnrollmentControlError, message: string) {
    super(message);
  }
  get status(): number {
    return this.code === "NOT_FOUND" ? 404 : 409;
  }
}

interface Actor {
  type: "user" | "system" | "integration";
  id: string | null;
}

interface LockedEnrollment {
  id: string;
  status: string;
  sequenceId: string;
  prospectId: string;
  sequenceVersionId: string | null;
}

async function lockEnrollment(tx: Db, workspaceId: string, enrollmentId: string): Promise<LockedEnrollment | null> {
  const rows = (await tx.execute(sql`
    select id, status, sequence_id as "sequenceId", prospect_id as "prospectId", sequence_version_id as "sequenceVersionId"
      from sequence_enrollments
     where id = ${enrollmentId} and workspace_id = ${workspaceId}
     for update`)) as unknown as LockedEnrollment[] | { rows: LockedEnrollment[] };
  const list = Array.isArray(rows) ? rows : rows.rows;
  return list[0] ?? null;
}

/**
 * Stops an enrollment. Returns false (no error) when it already ended, so every stop trigger can
 * call this without checking first; the first stop wins and keeps its reason.
 */
export async function stopEnrollment(
  db: Db,
  input: { workspaceId: string; enrollmentId: string; reason: StopReason; actor: Actor; note?: string | null; correlationId: string }
): Promise<{ stopped: boolean; cancelledSteps: number }> {
  const outcome = await db.transaction(async (tx) => {
    const enrollment = await lockEnrollment(tx as unknown as Db, input.workspaceId, input.enrollmentId);
    if (!enrollment) throw new EnrollmentControlFailure("NOT_FOUND", "Enrollment not found");
    if (enrollment.status !== "active" && enrollment.status !== "paused") return { stopped: false, cancelledSteps: 0, enrollment };
    await tx
      .update(sequenceEnrollments)
      .set({ status: "stopped", stopReason: input.reason, completedAt: new Date() })
      .where(eq(sequenceEnrollments.id, enrollment.id));
    const cancelled = await tx
      .update(sequenceEnrollmentSteps)
      .set({ status: "cancelled", failureReason: `stopped:${input.reason}` })
      .where(and(eq(sequenceEnrollmentSteps.enrollmentId, enrollment.id), eq(sequenceEnrollmentSteps.status, "scheduled")))
      .returning({ id: sequenceEnrollmentSteps.id });
    if (input.actor.type === "user") {
      await writeCopsAudit(tx, {
        tenantId: input.workspaceId,
        actor: { type: "user", id: input.actor.id },
        entityType: "sequence_enrollment",
        entityId: enrollment.id,
        action: "follow_up.stopped",
        before: { status: enrollment.status },
        after: { status: "stopped", stop_reason: input.reason },
        reason: input.note ?? input.reason,
        correlationId: input.correlationId,
        sourceChannel: "api",
      });
    }
    return { stopped: true, cancelledSteps: cancelled.length, enrollment };
  });
  if (outcome.stopped) {
    await recordSequenceEvent(db, {
      workspaceId: input.workspaceId,
      sequenceId: outcome.enrollment.sequenceId,
      enrollmentId: outcome.enrollment.id,
      sequenceVersionId: outcome.enrollment.sequenceVersionId,
      prospectId: outcome.enrollment.prospectId,
      eventType: "sequence_stopped",
      reason: input.reason,
      result: "stopped",
    });
  }
  return { stopped: outcome.stopped, cancelledSteps: outcome.cancelledSteps };
}

/** Stops every running onboarding follow-up of the account (activation, closed opportunity, ...). */
export async function stopAccountFollowUps(
  db: Db,
  input: { workspaceId: string; accountId: string; reason: StopReason; actor: Actor; correlationId: string }
): Promise<number> {
  const rows = await db
    .select({ enrollmentId: copsFollowUps.enrollmentId })
    .from(copsFollowUps)
    .innerJoin(sequenceEnrollments, eq(sequenceEnrollments.id, copsFollowUps.enrollmentId))
    .where(
      and(
        eq(copsFollowUps.workspaceId, input.workspaceId),
        eq(copsFollowUps.accountId, input.accountId),
        inArray(sequenceEnrollments.status, ["active", "paused"])
      )
    );
  let stopped = 0;
  for (const r of rows) {
    const res = await stopEnrollment(db, { ...input, enrollmentId: r.enrollmentId! });
    if (res.stopped) stopped += 1;
  }
  return stopped;
}

export async function pauseEnrollment(
  db: Db,
  input: { workspaceId: string; enrollmentId: string; actor: Actor; reason: string; correlationId: string }
): Promise<void> {
  await db.transaction(async (tx) => {
    const enrollment = await lockEnrollment(tx as unknown as Db, input.workspaceId, input.enrollmentId);
    if (!enrollment) throw new EnrollmentControlFailure("NOT_FOUND", "Enrollment not found");
    if (enrollment.status !== "active") throw new EnrollmentControlFailure("NOT_ACTIVE", `The follow-up is ${enrollment.status}, not active`);
    await tx.update(sequenceEnrollments).set({ status: "paused" }).where(eq(sequenceEnrollments.id, enrollment.id));
    await writeCopsAudit(tx, {
      tenantId: input.workspaceId,
      actor: { type: "user", id: input.actor.id },
      entityType: "sequence_enrollment",
      entityId: enrollment.id,
      action: "follow_up.paused",
      before: { status: "active" },
      after: { status: "paused" },
      reason: input.reason,
      correlationId: input.correlationId,
      sourceChannel: "api",
    });
  });
}

/** Resumes a paused enrollment and hands the next step to the scheduler (the worker skips paused ones). */
export async function resumeEnrollment(
  db: Db,
  input: { workspaceId: string; enrollmentId: string; actor: Actor; correlationId: string },
  scheduleNext: (e: { enrollmentId: string; workspaceId: string; prospectId: string; sequenceId: string }) => Promise<void>
): Promise<void> {
  const enrollment = await db.transaction(async (tx) => {
    const e = await lockEnrollment(tx as unknown as Db, input.workspaceId, input.enrollmentId);
    if (!e) throw new EnrollmentControlFailure("NOT_FOUND", "Enrollment not found");
    if (e.status !== "paused") throw new EnrollmentControlFailure("NOT_PAUSED", `The follow-up is ${e.status}, not paused`);
    await tx.update(sequenceEnrollments).set({ status: "active" }).where(eq(sequenceEnrollments.id, e.id));
    await writeCopsAudit(tx, {
      tenantId: input.workspaceId,
      actor: { type: "user", id: input.actor.id },
      entityType: "sequence_enrollment",
      entityId: e.id,
      action: "follow_up.resumed",
      before: { status: "paused" },
      after: { status: "active" },
      correlationId: input.correlationId,
      sourceChannel: "api",
    });
    return e;
  });
  await scheduleNext({ enrollmentId: enrollment.id, workspaceId: input.workspaceId, prospectId: enrollment.prospectId, sequenceId: enrollment.sequenceId });
}
