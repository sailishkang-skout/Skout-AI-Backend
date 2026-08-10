import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import { HttpError } from "../utils/http.js";
import { enqueueSequenceAdvanceJob } from "../workers/sequence-enrollment.queue.js";
import { resolveNotificationsForEntity } from "./notifications.service.js";
import type { Env } from "../config/env.js";

const log = createLogger("linkedin-outreach.service");
const { linkedinOutreachJobs, sequenceEnrollmentSteps, sequenceEnrollments } = schema;

export type LinkedinAction = "connect" | "message";

export class LinkedinOutreachService {
  constructor(
    private readonly db: Db,
    private readonly config: Env
  ) {}

  async listPending(workspaceId: string, limit = 10) {
    return this.db
      .select()
      .from(linkedinOutreachJobs)
      .where(
        and(
          eq(linkedinOutreachJobs.workspaceId, workspaceId),
          inArray(linkedinOutreachJobs.status, ["pending", "processing"])
        )
      )
      .orderBy(asc(linkedinOutreachJobs.createdAt))
      .limit(Math.min(Math.max(limit, 1), 25));
  }

  async claimJob(workspaceId: string, jobId: string) {
    const [job] = await this.db
      .select()
      .from(linkedinOutreachJobs)
      .where(
        and(eq(linkedinOutreachJobs.id, jobId), eq(linkedinOutreachJobs.workspaceId, workspaceId))
      );
    if (!job) throw new HttpError("linkedin_job_not_found", 404);
    if (job.status === "completed" || job.status === "failed") {
      return job;
    }

    const [updated] = await this.db
      .update(linkedinOutreachJobs)
      .set({ status: "processing", updatedAt: new Date() })
      .where(
        and(
          eq(linkedinOutreachJobs.id, jobId),
          inArray(linkedinOutreachJobs.status, ["pending", "processing"])
        )
      )
      .returning();
    return updated ?? job;
  }

  async completeJob(workspaceId: string, jobId: string) {
    const [job] = await this.db
      .select()
      .from(linkedinOutreachJobs)
      .where(
        and(eq(linkedinOutreachJobs.id, jobId), eq(linkedinOutreachJobs.workspaceId, workspaceId))
      );
    if (!job) throw new HttpError("linkedin_job_not_found", 404);
    if (job.status === "completed") return job;

    const [enrollment] = await this.db
      .select({ sequenceId: sequenceEnrollments.sequenceId })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, job.enrollmentId))
      .limit(1);

    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(linkedinOutreachJobs)
        .set({ status: "completed", completedAt: now, updatedAt: now, failureReason: null })
        .where(eq(linkedinOutreachJobs.id, jobId));
      await tx
        .update(sequenceEnrollmentSteps)
        .set({ status: "executed", executedAt: now, failureReason: null })
        .where(eq(sequenceEnrollmentSteps.id, job.enrollmentStepId));
    });

    // No longer needs a human's attention (R17.2) — resolve any pending reminder for this step.
    await resolveNotificationsForEntity(this.db, "sequence_enrollment_step", job.enrollmentStepId);

    if (enrollment) {
      await enqueueSequenceAdvanceJob(
        this.config,
        {
          enrollmentId: job.enrollmentId,
          workspaceId: job.workspaceId,
          prospectId: job.prospectId,
          sequenceId: enrollment.sequenceId,
        },
        0,
        false
      );
    }

    const [updated] = await this.db
      .select()
      .from(linkedinOutreachJobs)
      .where(eq(linkedinOutreachJobs.id, jobId));
    log.info("linkedin outreach job completed", { workspaceId, jobId });
    return updated!;
  }

  async failJob(workspaceId: string, jobId: string, reason: string) {
    const [job] = await this.db
      .select()
      .from(linkedinOutreachJobs)
      .where(
        and(eq(linkedinOutreachJobs.id, jobId), eq(linkedinOutreachJobs.workspaceId, workspaceId))
      );
    if (!job) throw new HttpError("linkedin_job_not_found", 404);
    if (job.status === "completed") return job;

    const [enrollment] = await this.db
      .select({ sequenceId: sequenceEnrollments.sequenceId })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, job.enrollmentId))
      .limit(1);

    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(linkedinOutreachJobs)
        .set({
          status: "failed",
          failureReason: reason.slice(0, 500),
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(linkedinOutreachJobs.id, jobId));
      await tx
        .update(sequenceEnrollmentSteps)
        .set({ status: "failed", executedAt: now, failureReason: reason.slice(0, 500) })
        .where(eq(sequenceEnrollmentSteps.id, job.enrollmentStepId));
    });

    // Failed is still terminal — no longer needs a human's attention either (R17.2).
    await resolveNotificationsForEntity(this.db, "sequence_enrollment_step", job.enrollmentStepId);

    if (enrollment) {
      await enqueueSequenceAdvanceJob(
        this.config,
        {
          enrollmentId: job.enrollmentId,
          workspaceId: job.workspaceId,
          prospectId: job.prospectId,
          sequenceId: enrollment.sequenceId,
        },
        0,
        false
      );
    }

    const [updated] = await this.db
      .select()
      .from(linkedinOutreachJobs)
      .where(eq(linkedinOutreachJobs.id, jobId));
    log.warn("linkedin outreach job failed", { workspaceId, jobId, reason: reason.slice(0, 200) });
    return updated!;
  }

  async ensureJobForStep(input: {
    workspaceId: string;
    enrollmentId: string;
    enrollmentStepId: string;
    prospectId: string;
    linkedinUrl: string;
    action: LinkedinAction;
    message: string | null;
  }) {
    const [existing] = await this.db
      .select()
      .from(linkedinOutreachJobs)
      .where(eq(linkedinOutreachJobs.enrollmentStepId, input.enrollmentStepId));
    if (existing) return existing;

    const [row] = await this.db
      .insert(linkedinOutreachJobs)
      .values({
        workspaceId: input.workspaceId,
        enrollmentId: input.enrollmentId,
        enrollmentStepId: input.enrollmentStepId,
        prospectId: input.prospectId,
        linkedinUrl: input.linkedinUrl,
        action: input.action,
        message: input.message,
        status: "pending",
      })
      .onConflictDoNothing()
      .returning();

    if (row) return row;

    const [again] = await this.db
      .select()
      .from(linkedinOutreachJobs)
      .where(eq(linkedinOutreachJobs.enrollmentStepId, input.enrollmentStepId));
    return again!;
  }
}

export function buildLinkedinOutreachService(db: Db | null | undefined, config: Env) {
  if (!db) return null;
  return new LinkedinOutreachService(db, config);
}
