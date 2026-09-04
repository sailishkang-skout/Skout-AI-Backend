import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo, scopedById } from "@skout/db";
import { createLogger } from "@skout/observability";
import { claimNext, recordResult, LeaseLostError } from "@skout/shared";
import { HttpError } from "../utils/http.js";
import { enqueueSequenceAdvanceJob } from "../workers/sequence-enrollment.queue.js";
import { resolveNotificationsForEntity } from "./notifications.service.js";
import type { Env } from "../config/env.js";

const log = createLogger("whatsapp-outreach.service");
const { whatsappOutreachJobs, sequenceEnrollmentSteps, sequenceEnrollments } = schema;

const CLAIM_LEASE_MS = 60_000;

export class WhatsappOutreachService {
  constructor(
    private readonly db: Db,
    private readonly config: Env
  ) {}

  async listPending(workspaceId: string, limit = 10) {
    return this.db
      .select()
      .from(whatsappOutreachJobs)
      .where(scopedTo(whatsappOutreachJobs, workspaceId, inArray(whatsappOutreachJobs.status, ["pending", "claimed"])))
      .orderBy(asc(whatsappOutreachJobs.createdAt))
      .limit(Math.min(Math.max(limit, 1), 25));
  }

  /** Claims a specific, already-known job (by id) if it's still pending. */
  async claimJob(workspaceId: string, jobId: string) {
    const [job] = await this.db
      .select()
      .from(whatsappOutreachJobs)
      .where(scopedById(whatsappOutreachJobs, workspaceId, jobId));
    if (!job) throw new HttpError("whatsapp_job_not_found", 404);
    if (job.status === "succeeded" || job.status === "failed" || job.status === "outcome_unknown") return job;

    const claimed = await claimNext(this.db, whatsappOutreachJobs, `whatsapp-${process.pid}`, CLAIM_LEASE_MS, eq(whatsappOutreachJobs.id, jobId));
    return claimed ?? job;
  }

  async completeJob(workspaceId: string, jobId: string) {
    const [job] = await this.db
      .select()
      .from(whatsappOutreachJobs)
      .where(scopedById(whatsappOutreachJobs, workspaceId, jobId));
    if (!job) throw new HttpError("whatsapp_job_not_found", 404);
    if (job.status === "succeeded") return job;

    const [enrollment] = await this.db
      .select({ sequenceId: sequenceEnrollments.sequenceId })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, job.enrollmentId))
      .limit(1);

    const now = new Date();
    let updated;
    try {
      updated = await recordResult(this.db, whatsappOutreachJobs, jobId, job.leaseOwner ?? `whatsapp-${process.pid}`, {
        status: "succeeded",
        completedAt: now,
        failureReason: null,
      });
    } catch (err) {
      if (err instanceof LeaseLostError) return job;
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

    log.info("whatsapp outreach job completed", { workspaceId, jobId });
    return updated;
  }

  async failJob(workspaceId: string, jobId: string, reason: string) {
    return this.settleFailed(workspaceId, jobId, reason, "failed");
  }

  /** Ambiguous provider outcome (Unipile request timeout with no confirmed delivery receipt) —
   * needs manual reconciliation, not a silent retry or a clean-failure classification. */
  async recordOutcomeUnknown(workspaceId: string, jobId: string, reason: string) {
    return this.settleFailed(workspaceId, jobId, reason, "outcome_unknown");
  }

  private async settleFailed(workspaceId: string, jobId: string, reason: string, status: "failed" | "outcome_unknown") {
    const [job] = await this.db
      .select()
      .from(whatsappOutreachJobs)
      .where(scopedById(whatsappOutreachJobs, workspaceId, jobId));
    if (!job) throw new HttpError("whatsapp_job_not_found", 404);
    if (job.status === "succeeded") return job;

    const [enrollment] = await this.db
      .select({ sequenceId: sequenceEnrollments.sequenceId })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, job.enrollmentId))
      .limit(1);

    const now = new Date();
    let updated;
    try {
      updated = await recordResult(this.db, whatsappOutreachJobs, jobId, job.leaseOwner ?? `whatsapp-${process.pid}`, {
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

    // outcome_unknown needs manual reconciliation — do NOT resolve the human-attention
    // notification for it, only for a genuine, confirmed failure (matches the LinkedIn plan's
    // Finding 4 fix, applied here from the start rather than discovered again).
    if (status === "failed") {
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

    log.warn("whatsapp outreach job settled", { workspaceId, jobId, status, reason: reason.slice(0, 200) });
    return updated;
  }

  async ensureJobForStep(input: {
    workspaceId: string;
    enrollmentId: string;
    enrollmentStepId: string;
    prospectId: string;
    phone: string;
    message: string | null;
  }) {
    const [existing] = await this.db
      .select()
      .from(whatsappOutreachJobs)
      .where(eq(whatsappOutreachJobs.enrollmentStepId, input.enrollmentStepId));
    if (existing) return existing;

    const [row] = await this.db
      .insert(whatsappOutreachJobs)
      .values({
        workspaceId: input.workspaceId,
        enrollmentId: input.enrollmentId,
        enrollmentStepId: input.enrollmentStepId,
        prospectId: input.prospectId,
        phone: input.phone,
        message: input.message,
        status: "pending",
      })
      .onConflictDoNothing()
      .returning();

    if (row) return row;

    const [again] = await this.db
      .select()
      .from(whatsappOutreachJobs)
      .where(eq(whatsappOutreachJobs.enrollmentStepId, input.enrollmentStepId));
    return again!;
  }
}

export function buildWhatsappOutreachService(db: Db | null | undefined, config: Env) {
  if (!db) return null;
  return new WhatsappOutreachService(db, config);
}
