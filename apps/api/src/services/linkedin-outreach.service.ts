import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import { claimNext, recordResult, LeaseLostError } from "@skout/shared";
import { HttpError } from "../utils/http.js";
import { enqueueSequenceAdvanceJob } from "../workers/sequence-enrollment.queue.js";
import { resolveNotificationsForEntity } from "./notifications.service.js";
import type { Env } from "../config/env.js";

const log = createLogger("linkedin-outreach.service");
const { linkedinOutreachJobs, sequenceEnrollmentSteps, sequenceEnrollments } = schema;

export type LinkedinAction = "connect" | "message";

const CLAIM_LEASE_MS = 60_000;

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
          inArray(linkedinOutreachJobs.status, ["pending", "claimed"])
        )
      )
      .orderBy(asc(linkedinOutreachJobs.createdAt))
      .limit(Math.min(Math.max(limit, 1), 25));
  }

  /**
   * Claims a specific, already-known job (by id) if it's still pending — used both by
   * executeLinkedinStep's hot path and the Chrome-extension-facing /linkedin/outreach/:id/claim
   * route. `claimNext`'s "oldest pending row" semantics correctly degrade to "this exact row, if
   * pending" when `extraWhere` pins a single id.
   */
  async claimJob(workspaceId: string, jobId: string) {
    const [job] = await this.db
      .select()
      .from(linkedinOutreachJobs)
      .where(and(eq(linkedinOutreachJobs.id, jobId), eq(linkedinOutreachJobs.workspaceId, workspaceId)));
    if (!job) throw new HttpError("linkedin_job_not_found", 404);
    if (job.status === "succeeded" || job.status === "failed" || job.status === "outcome_unknown") {
      return job;
    }

    const claimed = await claimNext(this.db, linkedinOutreachJobs, `linkedin-${process.pid}`, CLAIM_LEASE_MS, eq(linkedinOutreachJobs.id, jobId));
    return claimed ?? job;
  }

  async completeJob(workspaceId: string, jobId: string) {
    const [job] = await this.db
      .select()
      .from(linkedinOutreachJobs)
      .where(and(eq(linkedinOutreachJobs.id, jobId), eq(linkedinOutreachJobs.workspaceId, workspaceId)));
    if (!job) throw new HttpError("linkedin_job_not_found", 404);
    if (job.status === "succeeded") return job;

    const [enrollment] = await this.db
      .select({ sequenceId: sequenceEnrollments.sequenceId })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, job.enrollmentId))
      .limit(1);

    const now = new Date();
    let updated;
    try {
      updated = await recordResult(this.db, linkedinOutreachJobs, jobId, job.leaseOwner ?? `linkedin-${process.pid}`, {
        status: "succeeded",
        completedAt: now,
        failureReason: null,
      });
    } catch (err) {
      if (err instanceof LeaseLostError) return job; // another worker already owns this job now
      throw err;
    }

    await this.db
      .update(sequenceEnrollmentSteps)
      .set({ status: "executed", executedAt: now, failureReason: null })
      .where(eq(sequenceEnrollmentSteps.id, job.enrollmentStepId));

    await resolveNotificationsForEntity(this.db, "sequence_enrollment_step", job.enrollmentStepId);

    if (enrollment) {
      await enqueueSequenceAdvanceJob(
        this.config,
        { enrollmentId: job.enrollmentId, workspaceId: job.workspaceId, prospectId: job.prospectId, sequenceId: enrollment.sequenceId },
        0,
        false
      );
    }

    log.info("linkedin outreach job completed", { workspaceId, jobId });
    return updated;
  }

  async failJob(workspaceId: string, jobId: string, reason: string) {
    return this.settleFailed(workspaceId, jobId, reason, "failed");
  }

  /** Ambiguous provider outcome (Unipile request timeout with no confirmed delivery receipt) —
   * needs manual reconciliation rather than being silently retried or treated as a clean failure. */
  async recordOutcomeUnknown(workspaceId: string, jobId: string, reason: string) {
    return this.settleFailed(workspaceId, jobId, reason, "outcome_unknown");
  }

  private async settleFailed(workspaceId: string, jobId: string, reason: string, status: "failed" | "outcome_unknown") {
    const [job] = await this.db
      .select()
      .from(linkedinOutreachJobs)
      .where(and(eq(linkedinOutreachJobs.id, jobId), eq(linkedinOutreachJobs.workspaceId, workspaceId)));
    if (!job) throw new HttpError("linkedin_job_not_found", 404);
    if (job.status === "succeeded") return job;

    const [enrollment] = await this.db
      .select({ sequenceId: sequenceEnrollments.sequenceId })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, job.enrollmentId))
      .limit(1);

    const now = new Date();
    let updated;
    try {
      updated = await recordResult(this.db, linkedinOutreachJobs, jobId, job.leaseOwner ?? `linkedin-${process.pid}`, {
        status,
        failureReason: reason.slice(0, 500),
        completedAt: now,
      });
    } catch (err) {
      if (err instanceof LeaseLostError) return job;
      throw err;
    }

    await this.db
      .update(sequenceEnrollmentSteps)
      .set({ status: "failed", executedAt: now, failureReason: reason.slice(0, 500) })
      .where(eq(sequenceEnrollmentSteps.id, job.enrollmentStepId));

    // "outcome_unknown" means the outcome is genuinely ambiguous (e.g. a Unipile timeout with
    // no confirmed delivery receipt) and needs manual reconciliation — that's the opposite of
    // "no longer needs a human's attention". Only a real, confirmed failure resolves the
    // notification; an ambiguous one must keep surfacing until a human reconciles it.
    if (status !== "outcome_unknown") {
      await resolveNotificationsForEntity(this.db, "sequence_enrollment_step", job.enrollmentStepId);
    }

    if (enrollment) {
      await enqueueSequenceAdvanceJob(
        this.config,
        { enrollmentId: job.enrollmentId, workspaceId: job.workspaceId, prospectId: job.prospectId, sequenceId: enrollment.sequenceId },
        0,
        false
      );
    }

    log.warn("linkedin outreach job settled", { workspaceId, jobId, status, reason: reason.slice(0, 200) });
    return updated;
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
