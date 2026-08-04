import { and, asc, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import { HttpError } from "../utils/http.js";
import { stepScheduledAt } from "../utils/scheduling.js";

const log = createLogger("sequence.service");

const {
  sequences,
  sequenceSteps,
  sequenceEnrollments,
  sequenceEnrollmentSteps,
  sequenceTrackingEvents,
  listMembers,
  lists,
  prospectActivations,
} = schema;

const ENROLLMENT_STATUSES = ["active", "completed", "bounced", "replied"] as const;

export const STEP_TYPES = ["email", "linkedin", "whatsapp", "call", "wait", "task"] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const SEQUENCE_STATUSES = ["draft", "active", "paused", "archived"] as const;
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];

const STATUS_TRANSITIONS: Record<SequenceStatus, SequenceStatus[]> = {
  draft: ["active"],
  active: ["paused", "archived"],
  paused: ["active", "archived"],
  archived: [],
};

const MERGE_TOKENS = new Set([
  "firstName", "lastName", "fullName", "companyName", "companyDomain",
  "title", "senderName", "senderEmail", "unsubscribeUrl",
]);

function validateMergeTokens(template: string): void {
  const tokenRegex = /\{\{(\w+)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(template)) !== null) {
    if (!MERGE_TOKENS.has(match[1]!)) {
      throw new HttpError(`Unknown merge token: {{${match[1]}}}`, 422, {
        invalidToken: match[1],
        allowed: [...MERGE_TOKENS],
      });
    }
  }
}

export interface AddStepInput {
  stepType: StepType;
  delayDays: number;
  delayUnit?: "minutes" | "hours" | "days" | "weeks";
  linkedinAction?: "connect" | "message";
  subject?: string;
  bodyTemplate?: string;
}

export interface UpdateStepInput {
  stepType?: StepType;
  delayDays?: number;
  delayUnit?: "minutes" | "hours" | "days" | "weeks";
  linkedinAction?: "connect" | "message" | null;
  subject?: string | null;
  bodyTemplate?: string | null;
}

export class SequenceService {
  constructor(private readonly db: Db) {}

  async listSequences(workspaceId: string, status?: string) {
    return this.db
      .select()
      .from(sequences)
      .where(
        status
          ? and(eq(sequences.workspaceId, workspaceId), eq(sequences.status, status))
          : eq(sequences.workspaceId, workspaceId)
      )
      .orderBy(sequences.createdAt);
  }

  async createSequence(workspaceId: string, name: string) {
    const [row] = await this.db
      .insert(sequences)
      .values({ workspaceId, name, status: "draft" })
      .returning();
    log.info("sequence created", { workspaceId, sequenceId: row!.id, name });
    return row!;
  }

  /** Atomically creates a draft sequence with all its steps (used by AI generation). */
  async createGeneratedSequence(
    workspaceId: string,
    generated: {
      name: string;
      steps: {
        stepType: StepType;
        delayDays: number;
        delayUnit?: "minutes" | "hours" | "days" | "weeks";
        linkedinAction?: "connect" | "message";
        subject?: string | null;
        bodyTemplate?: string | null;
      }[];
    }
  ) {
    return this.db.transaction(async (tx) => {
      const [seq] = await tx
        .insert(sequences)
        .values({ workspaceId, name: generated.name, status: "draft" })
        .returning();
      const steps = [];
      for (let i = 0; i < generated.steps.length; i++) {
        const s = generated.steps[i]!;
        const [row] = await tx
          .insert(sequenceSteps)
          .values({
            sequenceId: seq!.id,
            stepOrder: i + 1,
            stepType: s.stepType,
            delayDays: s.delayDays,
            delayUnit: s.delayUnit ?? "days",
            linkedinAction:
              s.stepType === "linkedin" ? (s.linkedinAction ?? "connect") : null,
            subject: s.subject ?? null,
            bodyTemplate: s.bodyTemplate ?? null,
          })
          .returning();
        steps.push(row!);
      }
      log.info("generated sequence created", {
        workspaceId,
        sequenceId: seq!.id,
        name: generated.name,
        stepCount: steps.length,
      });
      return { ...seq!, steps };
    });
  }

  /** Recent sequences with their email steps — style reference for AI generation. */
  async getStyleExamples(workspaceId: string, limit = 3) {
    const recent = await this.db
      .select({ id: sequences.id, name: sequences.name })
      .from(sequences)
      .where(eq(sequences.workspaceId, workspaceId))
      .orderBy(desc(sequences.createdAt))
      .limit(limit);
    if (recent.length === 0) return [];

    const ids = recent.map((s) => s.id);
    const steps = await this.db
      .select({
        sequenceId: sequenceSteps.sequenceId,
        stepOrder: sequenceSteps.stepOrder,
        stepType: sequenceSteps.stepType,
        subject: sequenceSteps.subject,
        bodyTemplate: sequenceSteps.bodyTemplate,
      })
      .from(sequenceSteps)
      .where(inArray(sequenceSteps.sequenceId, ids))
      .orderBy(asc(sequenceSteps.stepOrder));

    return recent.map((s) => ({
      name: s.name,
      steps: steps.filter((st) => st.sequenceId === s.id),
    }));
  }

  async getSequenceById(workspaceId: string, id: string) {
    const [seq] = await this.db
      .select()
      .from(sequences)
      .where(and(eq(sequences.id, id), eq(sequences.workspaceId, workspaceId)));
    if (!seq) return null;

    const steps = await this.db
      .select()
      .from(sequenceSteps)
      .where(eq(sequenceSteps.sequenceId, id))
      .orderBy(asc(sequenceSteps.stepOrder));

    return { ...seq, steps };
  }

  async updateSequence(workspaceId: string, id: string, patch: { name?: string; status?: string }) {
    const [existing] = await this.db
      .select()
      .from(sequences)
      .where(and(eq(sequences.id, id), eq(sequences.workspaceId, workspaceId)));
    if (!existing) return null;

    if (patch.status) {
      const current = existing.status as SequenceStatus;
      const next = patch.status as SequenceStatus;
      if (!SEQUENCE_STATUSES.includes(next)) {
        throw new HttpError(`Invalid status: ${next}`, 422);
      }
      const allowed = STATUS_TRANSITIONS[current];
      if (!allowed.includes(next)) {
        throw new HttpError(
          `Cannot transition from "${current}" to "${next}"`,
          422,
          { current, requested: next, allowed }
        );
      }
    }

    const [updated] = await this.db
      .update(sequences)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(sequences.id, id), eq(sequences.workspaceId, workspaceId)))
      .returning();
    log.info("sequence updated", {
      workspaceId,
      sequenceId: id,
      name: patch.name,
      status: patch.status,
    });
    return updated!;
  }

  async deleteSequence(workspaceId: string, id: string) {
    await this.db
      .delete(sequences)
      .where(and(eq(sequences.id, id), eq(sequences.workspaceId, workspaceId)));
    log.info("sequence deleted", { workspaceId, sequenceId: id });
  }

  async addStep(workspaceId: string, sequenceId: string, input: AddStepInput) {
    const [seq] = await this.db
      .select()
      .from(sequences)
      .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId)));
    if (!seq) return null;

    if (input.bodyTemplate) {
      validateMergeTokens(input.bodyTemplate);
    }

    const existing = await this.db
      .select({ stepOrder: sequenceSteps.stepOrder })
      .from(sequenceSteps)
      .where(eq(sequenceSteps.sequenceId, sequenceId))
      .orderBy(asc(sequenceSteps.stepOrder));

    const nextOrder = existing.length + 1;

    const [row] = await this.db
      .insert(sequenceSteps)
      .values({
        sequenceId,
        stepOrder: nextOrder,
        stepType: input.stepType,
        delayDays: input.delayDays,
        delayUnit: input.delayUnit ?? "days",
        linkedinAction:
          input.stepType === "linkedin"
            ? (input.linkedinAction ?? "connect")
            : null,
        subject: input.subject,
        bodyTemplate: input.bodyTemplate,
      })
      .returning();
    return row!;
  }

  async updateStep(workspaceId: string, sequenceId: string, stepId: string, input: UpdateStepInput) {
    const [seq] = await this.db
      .select()
      .from(sequences)
      .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId)));
    if (!seq) return null;

    if (input.bodyTemplate) {
      validateMergeTokens(input.bodyTemplate);
    }

    const [updated] = await this.db
      .update(sequenceSteps)
      .set({
        ...(input.stepType !== undefined ? { stepType: input.stepType } : {}),
        ...(input.delayDays !== undefined ? { delayDays: input.delayDays } : {}),
        ...(input.delayUnit !== undefined ? { delayUnit: input.delayUnit } : {}),
        ...(input.linkedinAction !== undefined ? { linkedinAction: input.linkedinAction } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.bodyTemplate !== undefined ? { bodyTemplate: input.bodyTemplate } : {}),
      })
      .where(and(eq(sequenceSteps.id, stepId), eq(sequenceSteps.sequenceId, sequenceId)))
      .returning();
    return updated ?? null;
  }

  async deleteStep(workspaceId: string, sequenceId: string, stepId: string) {
    const [seq] = await this.db
      .select()
      .from(sequences)
      .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId)));
    if (!seq) return false;

    await this.db
      .delete(sequenceSteps)
      .where(and(eq(sequenceSteps.id, stepId), eq(sequenceSteps.sequenceId, sequenceId)));

    // Renumber remaining steps to keep order contiguous
    const remaining = await this.db
      .select()
      .from(sequenceSteps)
      .where(eq(sequenceSteps.sequenceId, sequenceId))
      .orderBy(asc(sequenceSteps.stepOrder));

    for (let i = 0; i < remaining.length; i++) {
      const step = remaining[i]!;
      if (step.stepOrder !== i + 1) {
        await this.db
          .update(sequenceSteps)
          .set({ stepOrder: i + 1 })
          .where(eq(sequenceSteps.id, step.id));
      }
    }

    return true;
  }

  async reorderSteps(workspaceId: string, sequenceId: string, orderedStepIds: string[]) {
    const [seq] = await this.db
      .select()
      .from(sequences)
      .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId)));
    if (!seq) return null;

    const existing = await this.db
      .select()
      .from(sequenceSteps)
      .where(eq(sequenceSteps.sequenceId, sequenceId));

    if (orderedStepIds.length !== existing.length) {
      throw new HttpError("orderedStepIds must contain every step ID exactly once", 422, {
        expected: existing.length,
        received: orderedStepIds.length,
      });
    }

    const existingIds = new Set(existing.map((s) => s.id));
    for (const id of orderedStepIds) {
      if (!existingIds.has(id)) {
        throw new HttpError(`Step ${id} does not belong to this sequence`, 422);
      }
    }

    // Two-pass update inside a transaction to avoid unique constraint violations
    await this.db.transaction(async (tx) => {
      const offset = existing.length + 1;
      for (let i = 0; i < orderedStepIds.length; i++) {
        await tx
          .update(sequenceSteps)
          .set({ stepOrder: offset + i })
          .where(eq(sequenceSteps.id, orderedStepIds[i]!));
      }
      for (let i = 0; i < orderedStepIds.length; i++) {
        await tx
          .update(sequenceSteps)
          .set({ stepOrder: i + 1 })
          .where(eq(sequenceSteps.id, orderedStepIds[i]!));
      }
    });

    return this.db
      .select()
      .from(sequenceSteps)
      .where(eq(sequenceSteps.sequenceId, sequenceId))
      .orderBy(asc(sequenceSteps.stepOrder));
  }

  /**
   * Enrolls one or more prospects into an active sequence.
   * - Resolves prospects from explicit `prospectIds` and/or a `listId`.
   * - Idempotent: UNIQUE(sequenceId, prospectId) — already-enrolled prospects
   *   are counted as `skipped` and not double-inserted.
   * - Materialises one `sequenceEnrollmentStep` row per step with `scheduledAt`
   *   pre-calculated (business-hours aware).
   * - Returns the new enrollment IDs + first-step scheduledAt so the caller
   *   can enqueue BullMQ advance jobs with the correct delay.
   */
  async enroll(
    sequenceId: string,
    workspaceId: string,
    input: { prospectIds?: string[]; listId?: string }
  ): Promise<{
    enrolled: number;
    skipped: number;
    total: number;
    newEnrollments: { enrollmentId: string; prospectId: string; firstStepScheduledAt: Date | null }[];
  }> {
    // Validate sequence exists and is active
    const [seq] = await this.db
      .select()
      .from(sequences)
      .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId)));
    if (!seq) throw new HttpError("sequence_not_found", 404);
    if (seq.status !== "active") {
      throw new HttpError(`Cannot enroll into a ${seq.status} sequence`, 422, {
        status: seq.status,
        required: "active",
      });
    }

    // Load steps in order
    const steps = await this.db
      .select()
      .from(sequenceSteps)
      .where(eq(sequenceSteps.sequenceId, sequenceId))
      .orderBy(asc(sequenceSteps.stepOrder));
    if (steps.length === 0) {
      throw new HttpError("Sequence has no steps — add at least one step before enrolling", 422);
    }

    // Resolve prospect IDs: combine explicit list + listId members, deduplicate
    const idSet = new Set<string>(input.prospectIds ?? []);
    if (input.listId) {
      const members = await this.db
        .select({ prospectId: listMembers.prospectId })
        .from(listMembers)
        .where(eq(listMembers.listId, input.listId));
      for (const m of members) idSet.add(m.prospectId);
    }
    if (idSet.size === 0) {
      throw new HttpError("No prospects to enroll — provide prospectIds or a listId", 422);
    }

    const prospectIds = [...idSet];
    const now = new Date();
    const newEnrollments: { enrollmentId: string; prospectId: string; firstStepScheduledAt: Date | null }[] = [];
    let skipped = 0;

    for (const prospectId of prospectIds) {
      // Insert enrollment — unique partial index allows only one *active* row.
      // Terminal enrollments are kept so analytics (sent/skipped) are not wiped on re-run.
      const inserted = await this.db
        .insert(sequenceEnrollments)
        .values({ workspaceId, sequenceId, prospectId, listId: input.listId ?? null, status: "active" })
        .onConflictDoNothing()
        .returning();

      if (inserted.length === 0) {
        skipped++;
        continue;
      }

      const enrollment = inserted[0]!;

      // Pre-calculate scheduledAt for each step
      let previousScheduledAt = now;
      let firstScheduledAt: Date | null = null;

      for (const step of steps) {
        const unit = (step.delayUnit ?? "days") as "minutes" | "hours" | "days" | "weeks";
        const scheduled = stepScheduledAt(previousScheduledAt, step.delayDays, unit);
        if (firstScheduledAt === null) firstScheduledAt = scheduled;
        previousScheduledAt = scheduled;

        await this.db
          .insert(sequenceEnrollmentSteps)
          .values({
            enrollmentId: enrollment.id,
            stepId: step.id,
            status: "scheduled",
            scheduledAt: scheduled,
          })
          .onConflictDoNothing();
      }

      newEnrollments.push({
        enrollmentId: enrollment.id,
        prospectId,
        firstStepScheduledAt: firstScheduledAt,
      });
    }

    log.info("sequence enroll completed", {
      workspaceId,
      sequenceId,
      enrolled: newEnrollments.length,
      skipped,
      total: prospectIds.length,
      listId: input.listId,
    });

    return {
      enrolled: newEnrollments.length,
      skipped,
      total: prospectIds.length,
      newEnrollments,
    };
  }

  /**
   * Per-step funnel metrics (scheduled/sent/failed/skipped + open/click counts,
   * attributed via sequence_tracking_events) plus an overall enrollment-status
   * summary. All counts are aggregated in JS over the (workspace-scoped) rows —
   * cadence volumes are small enough that this stays simple, matching the
   * existing analytics.service.ts convention.
   */
  async getAnalytics(workspaceId: string, sequenceId: string) {
    const [seq] = await this.db
      .select()
      .from(sequences)
      .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId)));
    if (!seq) return null;

    const steps = await this.db
      .select()
      .from(sequenceSteps)
      .where(eq(sequenceSteps.sequenceId, sequenceId))
      .orderBy(asc(sequenceSteps.stepOrder));

    const enrollments = await this.db
      .select({ id: sequenceEnrollments.id, status: sequenceEnrollments.status })
      .from(sequenceEnrollments)
      .where(and(eq(sequenceEnrollments.sequenceId, sequenceId), eq(sequenceEnrollments.workspaceId, workspaceId)));

    const enrollmentSummary = {
      total: enrollments.length,
      active: 0,
      completed: 0,
      bounced: 0,
      replied: 0,
    };
    for (const e of enrollments) {
      if ((ENROLLMENT_STATUSES as readonly string[]).includes(e.status)) {
        enrollmentSummary[e.status as (typeof ENROLLMENT_STATUSES)[number]]++;
      }
    }

    if (steps.length === 0) {
      return { id: seq.id, name: seq.name, status: seq.status, enrollments: enrollmentSummary, steps: [] };
    }

    const enrollmentIds = enrollments.map((e) => e.id);
    const enrollmentSteps =
      enrollmentIds.length === 0
        ? []
        : await this.db
            .select({
              id: sequenceEnrollmentSteps.id,
              stepId: sequenceEnrollmentSteps.stepId,
              status: sequenceEnrollmentSteps.status,
            })
            .from(sequenceEnrollmentSteps)
            .where(inArray(sequenceEnrollmentSteps.enrollmentId, enrollmentIds));

    const enrollmentStepIds = enrollmentSteps.map((s) => s.id);
    const trackingEvents =
      enrollmentStepIds.length === 0
        ? []
        : await this.db
            .select({
              enrollmentStepId: sequenceTrackingEvents.enrollmentStepId,
              eventType: sequenceTrackingEvents.eventType,
            })
            .from(sequenceTrackingEvents)
            .where(inArray(sequenceTrackingEvents.enrollmentStepId, enrollmentStepIds));

    // Distinct enrollment-steps with >=1 open/click, attributed to their parent step.
    const openedEnrollmentSteps = new Set<string>();
    const clickedEnrollmentSteps = new Set<string>();
    for (const ev of trackingEvents) {
      if (ev.eventType === "open") openedEnrollmentSteps.add(ev.enrollmentStepId);
      else if (ev.eventType === "click") clickedEnrollmentSteps.add(ev.enrollmentStepId);
    }

    const stepMetrics = new Map<
      string,
      { scheduled: number; executed: number; failed: number; skipped: number; opens: number; clicks: number }
    >();
    for (const es of enrollmentSteps) {
      const bucket =
        stepMetrics.get(es.stepId) ??
        { scheduled: 0, executed: 0, failed: 0, skipped: 0, opens: 0, clicks: 0 };
      if (es.status === "scheduled") bucket.scheduled++;
      else if (es.status === "executed") bucket.executed++;
      else if (es.status === "failed") bucket.failed++;
      else if (es.status === "skipped") bucket.skipped++;
      if (openedEnrollmentSteps.has(es.id)) bucket.opens++;
      if (clickedEnrollmentSteps.has(es.id)) bucket.clicks++;
      stepMetrics.set(es.stepId, bucket);
    }

    const stepsOut = steps.map((step) => {
      const m = stepMetrics.get(step.id) ?? {
        scheduled: 0, executed: 0, failed: 0, skipped: 0, opens: 0, clicks: 0,
      };
      const opens = m.opens;
      const clicks = m.clicks;
      const sent = m.executed;
      return {
        stepId: step.id,
        stepOrder: step.stepOrder,
        stepType: step.stepType,
        subject: step.subject,
        delayDays: step.delayDays,
        scheduled: m.scheduled,
        sent,
        failed: m.failed,
        skipped: m.skipped,
        opens,
        clicks,
        openRate: sent > 0 ? Math.round((opens / sent) * 100) : 0,
        clickRate: sent > 0 ? Math.round((clicks / sent) * 100) : 0,
      };
    });

    return { id: seq.id, name: seq.name, status: seq.status, enrollments: enrollmentSummary, steps: stepsOut };
  }

  /** Cancel an active enrollment — marks it cancelled and stops future steps. */
  async unenroll(workspaceId: string, sequenceId: string, prospectId: string) {
    const [updated] = await this.db
      .update(sequenceEnrollments)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(
        and(
          eq(sequenceEnrollments.sequenceId, sequenceId),
          eq(sequenceEnrollments.workspaceId, workspaceId),
          eq(sequenceEnrollments.prospectId, prospectId)
        )
      )
      .returning({ id: sequenceEnrollments.id });
    return updated ?? null;
  }

  /** Check if a prospect is actively enrolled in any sequence in this workspace. */
  async getProspectEnrollments(workspaceId: string, prospectId: string) {
    return this.db
      .select({
        id: sequenceEnrollments.id,
        sequenceId: sequenceEnrollments.sequenceId,
        status: sequenceEnrollments.status,
        enrolledAt: sequenceEnrollments.enrolledAt,
      })
      .from(sequenceEnrollments)
      .where(
        and(
          eq(sequenceEnrollments.workspaceId, workspaceId),
          eq(sequenceEnrollments.prospectId, prospectId)
        )
      )
      .orderBy(desc(sequenceEnrollments.enrolledAt));
  }

  /** Enrollment list with live per-prospect status, for the enroll-flow UI. */
  async listEnrollments(workspaceId: string, sequenceId: string) {
    const [seq] = await this.db
      .select()
      .from(sequences)
      .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId)));
    if (!seq) return null;

    const rows = await this.db
      .select({
        id: sequenceEnrollments.id,
        prospectId: sequenceEnrollments.prospectId,
        listId: sequenceEnrollments.listId,
        status: sequenceEnrollments.status,
        enrolledAt: sequenceEnrollments.enrolledAt,
        completedAt: sequenceEnrollments.completedAt,
        prospectName: sql<string | null>`${prospectActivations.snapshot}->>'fullName'`,
        prospectTitle: sql<string | null>`${prospectActivations.snapshot}->>'title'`,
        companyName: sql<string | null>`coalesce(${prospectActivations.snapshot}->>'companyName', ${prospectActivations.snapshot}->>'companyDomain')`,
        email: sql<string | null>`${prospectActivations.snapshot}->>'email'`,
      })
      .from(sequenceEnrollments)
      .leftJoin(
        prospectActivations,
        and(
          eq(prospectActivations.workspaceId, sequenceEnrollments.workspaceId),
          eq(prospectActivations.prospectId, sequenceEnrollments.prospectId)
        )
      )
      .where(and(eq(sequenceEnrollments.sequenceId, sequenceId), eq(sequenceEnrollments.workspaceId, workspaceId)))
      .orderBy(desc(sequenceEnrollments.enrolledAt));

    return rows;
  }

  /** Lists that have at least one enrollment in this sequence, with prospect counts per status. */
  async listEnrolledLists(workspaceId: string, sequenceId: string) {
    const [seq] = await this.db
      .select()
      .from(sequences)
      .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId)));
    if (!seq) return null;

    // Join via listMembers so we catch both list-enrolled AND member-selected enrollments
    const rows = await this.db
      .select({
        listId: listMembers.listId,
        listName: lists.name,
        total: count(sequenceEnrollments.id),
        active: sql<number>`count(*) filter (where ${sequenceEnrollments.status} = 'active')`,
        completed: sql<number>`count(*) filter (where ${sequenceEnrollments.status} = 'completed')`,
        enrolledAt: sql<string>`min(${sequenceEnrollments.enrolledAt})`,
      })
      .from(sequenceEnrollments)
      .innerJoin(listMembers, eq(listMembers.prospectId, sequenceEnrollments.prospectId))
      .innerJoin(lists, and(eq(lists.id, listMembers.listId), eq(lists.workspaceId, workspaceId)))
      .where(
        and(
          eq(sequenceEnrollments.sequenceId, sequenceId),
          eq(sequenceEnrollments.workspaceId, workspaceId),
        )
      )
      .groupBy(listMembers.listId, lists.name)
      .orderBy(sql`min(${sequenceEnrollments.enrolledAt}) desc`);

    return rows.map((r) => ({
      listId: r.listId,
      listName: r.listName ?? "Deleted list",
      total: Number(r.total),
      active: Number(r.active),
      completed: Number(r.completed),
      enrolledAt: r.enrolledAt,
    }));
  }

  /** Sequences that have enrollments sourced from a specific list. */
  async listSequencesForList(workspaceId: string, listId: string) {
    const [list] = await this.db
      .select({ id: lists.id })
      .from(lists)
      .where(and(eq(lists.id, listId), eq(lists.workspaceId, workspaceId)));
    if (!list) return null;

    // Collect all prospectIds in this list so we can match enrollments done via prospectIds too
    const memberRows = await this.db
      .select({ prospectId: listMembers.prospectId })
      .from(listMembers)
      .where(eq(listMembers.listId, listId));
    const memberIds = memberRows.map((m) => m.prospectId);

    const rows = await this.db
      .select({
        sequenceId: sequenceEnrollments.sequenceId,
        sequenceName: sequences.name,
        sequenceStatus: sequences.status,
        total: count(sequenceEnrollments.id),
        active: sql<number>`count(*) filter (where ${sequenceEnrollments.status} = 'active')`,
        completed: sql<number>`count(*) filter (where ${sequenceEnrollments.status} = 'completed')`,
        enrolledAt: sql<string>`min(${sequenceEnrollments.enrolledAt})`,
      })
      .from(sequenceEnrollments)
      .leftJoin(sequences, eq(sequences.id, sequenceEnrollments.sequenceId))
      .where(
        and(
          eq(sequenceEnrollments.workspaceId, workspaceId),
          memberIds.length > 0
            ? inArray(sequenceEnrollments.prospectId, memberIds)
            : eq(sequenceEnrollments.listId, listId),
        )
      )
      .groupBy(sequenceEnrollments.sequenceId, sequences.name, sequences.status)
      .orderBy(sql`min(${sequenceEnrollments.enrolledAt}) desc`);

    return rows.map((r) => ({
      sequenceId: r.sequenceId,
      sequenceName: r.sequenceName ?? "Deleted sequence",
      sequenceStatus: r.sequenceStatus ?? "archived",
      total: Number(r.total),
      active: Number(r.active),
      completed: Number(r.completed),
      enrolledAt: r.enrolledAt,
    }));
  }
}

export function buildSequenceService(db: Db | null): SequenceService | null {
  if (!db) return null;
  return new SequenceService(db);
}
