import { and, asc, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import { HttpError } from "../utils/http.js";
import { stepScheduledAt } from "../utils/scheduling.js";
import {
  assignExperimentVariant,
  type ConditionExpression,
} from "./sequence-condition.js";
import { recordSequenceEvent } from "./sequence-events.js";

const log = createLogger("sequence.service");

const {
  sequences,
  sequenceSteps,
  sequenceStepVariants,
  sequenceEnrollments,
  sequenceEnrollmentSteps,
  sequenceTrackingEvents,
  sequenceVersions,
  sequenceEvents,
  sequenceExperiments,
  listMembers,
  lists,
  prospectActivations,
} = schema;

const ENROLLMENT_STATUSES = ["active", "completed", "bounced", "replied"] as const;

export const STEP_TYPES = ["email", "linkedin", "whatsapp", "call", "wait", "task", "condition", "goal"] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const SEQUENCE_SOURCES = ["manual", "template", "dexter"] as const;
export type SequenceSource = (typeof SEQUENCE_SOURCES)[number];

/** A = default, B = LinkedIn-first variant, C = God Mode (spec §4–6). */
export const SEQUENCE_MODES = ["A", "B", "C"] as const;
export type SequenceMode = (typeof SEQUENCE_MODES)[number];

export const CONDITION_TYPES = [
  "linkedin_connected",
  "linkedin_invite_accepted",
  "linkedin_invite_declined",
  "email_opened",
  "email_clicked",
  "email_replied",
  "call_connected",
  "icp_score_gte",
  "has_email",
  "has_linkedin",
  "meeting_booked",
  "account_has_positive_reply",
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export const VARIANT_KEYS = ["A", "B", "C"] as const;
export type VariantKey = (typeof VARIANT_KEYS)[number];

export const LINKEDIN_ACTIONS = ["connect", "message", "inmail", "like", "follow"] as const;

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

export interface StepVariantInput {
  variantKey: VariantKey;
  subject?: string | null;
  bodyTemplate?: string | null;
  weight?: number;
  enabled?: boolean;
}

export interface AddStepInput {
  stepType: StepType;
  delayDays: number;
  delayUnit?: "minutes" | "hours" | "days" | "weeks";
  linkedinAction?: (typeof LINKEDIN_ACTIONS)[number];
  subject?: string;
  bodyTemplate?: string;
  conditionType?: ConditionType | null;
  conditionExpression?: ConditionExpression | null;
  conditionWaitDays?: number;
  yesNextStepId?: string | null;
  noNextStepId?: string | null;
  parentStepId?: string | null;
  branch?: "yes" | "no" | null;
  goalLabel?: string | null;
  variants?: StepVariantInput[];
}

export interface UpdateStepInput {
  stepType?: StepType;
  delayDays?: number;
  delayUnit?: "minutes" | "hours" | "days" | "weeks";
  linkedinAction?: (typeof LINKEDIN_ACTIONS)[number] | null;
  subject?: string | null;
  bodyTemplate?: string | null;
  conditionType?: ConditionType | null;
  conditionExpression?: ConditionExpression | null;
  conditionWaitDays?: number;
  yesNextStepId?: string | null;
  noNextStepId?: string | null;
  parentStepId?: string | null;
  branch?: "yes" | "no" | null;
  goalLabel?: string | null;
  variants?: StepVariantInput[];
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

  async createSequence(
    workspaceId: string,
    name: string,
    opts?: { source?: SequenceSource; templateKey?: string; mode?: SequenceMode }
  ) {
    const [row] = await this.db
      .insert(sequences)
      .values({
        workspaceId,
        name,
        status: "draft",
        source: opts?.source ?? "manual",
        templateKey: opts?.templateKey ?? null,
        mode: opts?.mode ?? (opts?.source === "manual" ? "C" : "A"),
      })
      .returning();
    log.info("sequence created", {
      workspaceId,
      sequenceId: row!.id,
      name,
      source: opts?.source,
      mode: opts?.mode,
    });
    return row!;
  }

  /** Atomically creates a draft sequence with all its steps (used by AI generation). */
  async createGeneratedSequence(
    workspaceId: string,
    generated: {
      name: string;
      source?: SequenceSource;
      templateKey?: string;
      mode?: SequenceMode;
      steps: {
        stepType: StepType;
        delayDays: number;
        delayUnit?: "minutes" | "hours" | "days" | "weeks";
        linkedinAction?: (typeof LINKEDIN_ACTIONS)[number];
        subject?: string | null;
        bodyTemplate?: string | null;
        conditionType?: ConditionType | null;
        conditionExpression?: ConditionExpression | null;
        conditionWaitDays?: number;
        parentStepId?: string | null;
        branch?: "yes" | "no" | null;
        goalLabel?: string | null;
      }[];
    }
  ) {
    return this.db.transaction(async (tx) => {
      const [seq] = await tx
        .insert(sequences)
        .values({
          workspaceId,
          name: generated.name,
          status: "draft",
          source: generated.source ?? "dexter",
          templateKey: generated.templateKey ?? null,
          mode: generated.mode ?? (generated.source === "dexter" ? "C" : "A"),
        })
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
            conditionType: s.conditionType ?? null,
            conditionExpression: s.conditionExpression ?? null,
            conditionWaitDays: s.conditionWaitDays ?? 2,
            parentStepId: s.parentStepId ?? null,
            branch: s.branch ?? null,
            goalLabel: s.goalLabel ?? null,
          })
          .returning();
        if (row && (s.stepType === "email" || s.stepType === "linkedin")) {
          await seedDefaultVariants(tx as unknown as Db, row.id, s.subject ?? null, s.bodyTemplate ?? null);
        }
        steps.push(row!);
      }
      await wireConditionParents(tx as unknown as Db, generated.steps, steps);
      const wiredSteps = await tx
        .select()
        .from(sequenceSteps)
        .where(eq(sequenceSteps.sequenceId, seq!.id))
        .orderBy(asc(sequenceSteps.stepOrder));
      log.info("generated sequence created", {
        workspaceId,
        sequenceId: seq!.id,
        name: generated.name,
        stepCount: wiredSteps.length,
      });
      return { ...seq!, steps: wiredSteps };
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

    const variants =
      steps.length === 0
        ? []
        : await this.db
            .select()
            .from(sequenceStepVariants)
            .where(
              inArray(
                sequenceStepVariants.stepId,
                steps.map((s) => s.id)
              )
            );

    return {
      ...seq,
      steps: steps.map((step) => ({
        ...step,
        variants: variants.filter((v) => v.stepId === step.id),
      })),
    };
  }

  async updateSequence(workspaceId: string, id: string, patch: { name?: string; status?: string; mode?: SequenceMode }) {
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
      if (next === "active") {
        if (existing.mode === "C" && !existing.modeCApprovedAt) {
          throw new HttpError(
            "Mode C sequences require explicit approval before activation",
            422,
            { sequenceId: id }
          );
        }
        const steps = await this.db
          .select()
          .from(sequenceSteps)
          .where(eq(sequenceSteps.sequenceId, id))
          .orderBy(asc(sequenceSteps.stepOrder));
        validateSequenceForPublish(steps);
      }
      if (next === "paused" && current === "active") {
        await recordSequenceEvent(this.db, {
          workspaceId,
          sequenceId: id,
          eventType: "sequence_paused",
          reason: "USER_STOPPED",
        });
      }
      if (next === "active" && current === "paused") {
        await recordSequenceEvent(this.db, {
          workspaceId,
          sequenceId: id,
          eventType: "sequence_resumed",
        });
      }
    }

    const [updated] = await this.db
      .update(sequences)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(sequences.id, id), eq(sequences.workspaceId, workspaceId)))
      .returning();
    if (patch.status === "active" && existing.status === "draft" && updated) {
      await this.publishVersion(workspaceId, id);
    }
    log.info("sequence updated", {
      workspaceId,
      sequenceId: id,
      name: patch.name,
      status: patch.status,
    });
    return updated!;
  }

  /** Records explicit human approval for a Mode C ("God Mode") sequence — required before it can go active. */
  async approveModeC(workspaceId: string, id: string, approvedBy: string) {
    const [existing] = await this.db
      .select()
      .from(sequences)
      .where(and(eq(sequences.id, id), eq(sequences.workspaceId, workspaceId)));
    if (!existing) return null;
    if (existing.mode !== "C") {
      throw new HttpError(`Only Mode C sequences require approval (this sequence is mode "${existing.mode}")`, 422);
    }

    const [updated] = await this.db
      .update(sequences)
      .set({ modeCApprovedAt: new Date(), modeCApprovedBy: approvedBy, updatedAt: new Date() })
      .where(and(eq(sequences.id, id), eq(sequences.workspaceId, workspaceId)))
      .returning();
    log.info("sequence mode C approved", { workspaceId, sequenceId: id, approvedBy });
    return updated!;
  }

  /** Snapshot the current graph as a published version (spec §32). In-flight enrollments keep their version. */
  async publishVersion(workspaceId: string, sequenceId: string) {
    const detail = await this.getSequenceById(workspaceId, sequenceId);
    if (!detail) throw new HttpError("sequence_not_found", 404);
    validateSequenceForPublish(detail.steps);
    const nextVersion = (detail.currentVersion ?? 0) + 1;
    const [row] = await this.db
      .insert(sequenceVersions)
      .values({
        sequenceId,
        version: nextVersion,
        status: "published",
        snapshot: {
          version: nextVersion,
          steps: detail.steps,
        },
      })
      .returning();
    await this.db
      .update(sequences)
      .set({ currentVersion: nextVersion, updatedAt: new Date() })
      .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId)));
    log.info("sequence version published", { workspaceId, sequenceId, version: nextVersion });
    return row!;
  }

  async listVersions(workspaceId: string, sequenceId: string) {
    const [seq] = await this.db
      .select({ id: sequences.id })
      .from(sequences)
      .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId)));
    if (!seq) return null;
    return this.db
      .select({
        id: sequenceVersions.id,
        version: sequenceVersions.version,
        status: sequenceVersions.status,
        publishedAt: sequenceVersions.publishedAt,
      })
      .from(sequenceVersions)
      .where(eq(sequenceVersions.sequenceId, sequenceId))
      .orderBy(desc(sequenceVersions.version));
  }

  async listEvents(workspaceId: string, sequenceId: string, opts?: { enrollmentId?: string; limit?: number }) {
    const [seq] = await this.db
      .select({ id: sequences.id })
      .from(sequences)
      .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId)));
    if (!seq) return null;
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
    const rows = await this.db
      .select()
      .from(sequenceEvents)
      .where(
        opts?.enrollmentId
          ? and(eq(sequenceEvents.sequenceId, sequenceId), eq(sequenceEvents.enrollmentId, opts.enrollmentId))
          : eq(sequenceEvents.sequenceId, sequenceId)
      )
      .orderBy(desc(sequenceEvents.createdAt))
      .limit(limit);
    return rows;
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
        conditionType: input.conditionType ?? null,
        conditionExpression: input.conditionExpression ?? null,
        conditionWaitDays: input.conditionWaitDays ?? 2,
        yesNextStepId: input.yesNextStepId ?? null,
        noNextStepId: input.noNextStepId ?? null,
        parentStepId: input.parentStepId ?? null,
        branch: input.branch ?? null,
        goalLabel: input.goalLabel ?? null,
      })
      .returning();

    if (row && (input.stepType === "email" || input.stepType === "linkedin" || input.variants?.length)) {
      if (input.variants?.length) {
        await upsertVariants(this.db, row.id, input.variants);
      } else {
        await seedDefaultVariants(this.db, row.id, input.subject ?? null, input.bodyTemplate ?? null);
      }
    }
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
        ...(input.conditionType !== undefined ? { conditionType: input.conditionType } : {}),
        ...(input.conditionExpression !== undefined ? { conditionExpression: input.conditionExpression } : {}),
        ...(input.conditionWaitDays !== undefined ? { conditionWaitDays: input.conditionWaitDays } : {}),
        ...(input.yesNextStepId !== undefined ? { yesNextStepId: input.yesNextStepId } : {}),
        ...(input.noNextStepId !== undefined ? { noNextStepId: input.noNextStepId } : {}),
        ...(input.parentStepId !== undefined ? { parentStepId: input.parentStepId } : {}),
        ...(input.branch !== undefined ? { branch: input.branch } : {}),
        ...(input.goalLabel !== undefined ? { goalLabel: input.goalLabel } : {}),
      })
      .where(and(eq(sequenceSteps.id, stepId), eq(sequenceSteps.sequenceId, sequenceId)))
      .returning();

    if (updated && input.variants) {
      await upsertVariants(this.db, updated.id, input.variants);
    }
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
    input: {
      prospectIds?: string[];
      listId?: string;
      experimentId?: string;
      experimentVariant?: "A" | "B" | "C";
    }
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

    const [latestVersion] = await this.db
      .select()
      .from(sequenceVersions)
      .where(eq(sequenceVersions.sequenceId, sequenceId))
      .orderBy(desc(sequenceVersions.version))
      .limit(1);

    for (const prospectId of prospectIds) {
      // Insert enrollment — unique partial index allows only one *active* row.
      // Terminal enrollments are kept so analytics (sent/skipped) are not wiped on re-run.
      const inserted = await this.db
        .insert(sequenceEnrollments)
        .values({
          workspaceId,
          sequenceId,
          prospectId,
          listId: input.listId ?? null,
          status: "active",
          experimentId: input.experimentId ?? null,
          experimentVariant: input.experimentVariant ?? (seq.mode === "C" ? null : (seq.mode ?? "A")),
          sequenceVersionId: latestVersion?.id ?? null,
        })
        .onConflictDoNothing()
        .returning();

      if (inserted.length === 0) {
        skipped++;
        continue;
      }

      const enrollment = inserted[0]!;

      // §5.2 — ensure prospect↔CRM contact link on enroll (best-effort)
      try {
        const { ensureContactLinkedToProspect } = await import("./prospect-crm-link.service.js");
        await ensureContactLinkedToProspect(this.db, workspaceId, prospectId);
      } catch (err) {
        log.warn("prospect↔CRM link on enroll failed", { err, prospectId });
      }

      // Pre-calculate scheduledAt for each step
      let previousScheduledAt = now;
      let firstScheduledAt: Date | null = null;

      for (const step of steps) {
        const isBranch = Boolean(step.parentStepId || step.branch);
        const unit = (step.delayUnit ?? "days") as "minutes" | "hours" | "days" | "weeks";
        const scheduled = stepScheduledAt(previousScheduledAt, step.delayDays, unit);
        if (!isBranch) {
          if (firstScheduledAt === null) firstScheduledAt = scheduled;
          previousScheduledAt = scheduled;
        }

        await this.db
          .insert(sequenceEnrollmentSteps)
          .values({
            enrollmentId: enrollment.id,
            stepId: step.id,
            status: isBranch ? "pending" : "scheduled",
            scheduledAt: isBranch ? null : scheduled,
          })
          .onConflictDoNothing();
      }

      await recordSequenceEvent(this.db, {
        workspaceId,
        sequenceId,
        enrollmentId: enrollment.id,
        sequenceVersionId: latestVersion?.id ?? null,
        prospectId,
        eventType: "sequence_started",
        variantKey: input.experimentVariant ?? seq.mode ?? null,
        reason: latestVersion ? `version_${latestVersion.version}` : null,
      });

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

    try {
      const { incrJourneyMetric } = await import("./journey-metrics.js");
      incrJourneyMetric("sequenceEnroll", newEnrollments.length);
    } catch {
      /* ignore */
    }

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
      {
        scheduled: number;
        executed: number;
        failed: number;
        skipped: number;
        // Call steps land here (status "awaiting_disposition") after the due-step trigger
        // creates a task and waits on a human to actually dial and set a disposition — a real,
        // intentional state that isn't scheduled/sent/failed/skipped. Previously unbucketed
        // entirely, so a working call step showed as 0 everywhere in Analytics.
        pending: number;
        opens: number;
        clicks: number;
      }
    >();
    for (const es of enrollmentSteps) {
      const bucket =
        stepMetrics.get(es.stepId) ??
        { scheduled: 0, executed: 0, failed: 0, skipped: 0, pending: 0, opens: 0, clicks: 0 };
      if (es.status === "scheduled") bucket.scheduled++;
      else if (es.status === "executed") bucket.executed++;
      else if (es.status === "failed") bucket.failed++;
      else if (es.status === "skipped") bucket.skipped++;
      else if (es.status === "awaiting_disposition") bucket.pending++;
      if (openedEnrollmentSteps.has(es.id)) bucket.opens++;
      if (clickedEnrollmentSteps.has(es.id)) bucket.clicks++;
      stepMetrics.set(es.stepId, bucket);
    }

    const stepsOut = steps.map((step) => {
      const m = stepMetrics.get(step.id) ?? {
        scheduled: 0, executed: 0, failed: 0, skipped: 0, pending: 0, opens: 0, clicks: 0,
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
        pending: m.pending,
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
      .set({ status: "cancelled", completedAt: new Date(), stopReason: "USER_STOPPED" })
      .where(
        and(
          eq(sequenceEnrollments.sequenceId, sequenceId),
          eq(sequenceEnrollments.workspaceId, workspaceId),
          eq(sequenceEnrollments.prospectId, prospectId)
        )
      )
      .returning({ id: sequenceEnrollments.id, sequenceVersionId: sequenceEnrollments.sequenceVersionId });
    if (updated) {
      await recordSequenceEvent(this.db, {
        workspaceId,
        sequenceId,
        enrollmentId: updated.id,
        sequenceVersionId: updated.sequenceVersionId,
        prospectId,
        eventType: "sequence_stopped",
        reason: "USER_STOPPED",
      });
    }
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
        experimentVariant: sequenceEnrollments.experimentVariant,
        stopReason: sequenceEnrollments.stopReason,
        sequenceVersionId: sequenceEnrollments.sequenceVersionId,
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

  async createExperiment(
    workspaceId: string,
    input: {
      name: string;
      sequenceAId: string;
      sequenceBId: string;
      weightA?: number;
      weightB?: number;
      primaryMetric?: string;
      durationDays?: number;
    }
  ) {
    if (input.sequenceAId === input.sequenceBId) {
      throw new HttpError("A/B experiment requires two different sequences", 422);
    }
    const pair = await this.db
      .select({ id: sequences.id, status: sequences.status, workspaceId: sequences.workspaceId })
      .from(sequences)
      .where(inArray(sequences.id, [input.sequenceAId, input.sequenceBId]));
    if (pair.length !== 2 || pair.some((s) => s.workspaceId !== workspaceId)) {
      throw new HttpError("Both sequences must belong to this workspace", 404);
    }
    const weightA = input.weightA ?? 50;
    const weightB = input.weightB ?? 50;
    if (weightA + weightB <= 0) throw new HttpError("A/B weights must sum to more than 0", 422);
    const [row] = await this.db
      .insert(sequenceExperiments)
      .values({
        workspaceId,
        name: input.name,
        sequenceAId: input.sequenceAId,
        sequenceBId: input.sequenceBId,
        weightA,
        weightB,
        primaryMetric: input.primaryMetric ?? "positive_reply",
        durationDays: input.durationDays ?? 30,
        status: "draft",
      })
      .returning();
    return row!;
  }

  async listExperiments(workspaceId: string) {
    const rows = await this.db
      .select()
      .from(sequenceExperiments)
      .where(eq(sequenceExperiments.workspaceId, workspaceId))
      .orderBy(desc(sequenceExperiments.createdAt));
    return rows;
  }

  async getExperiment(workspaceId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(sequenceExperiments)
      .where(and(eq(sequenceExperiments.id, id), eq(sequenceExperiments.workspaceId, workspaceId)));
    if (!row) return null;
    const [seqA] = await this.db.select({ id: sequences.id, name: sequences.name, status: sequences.status, mode: sequences.mode }).from(sequences).where(eq(sequences.id, row.sequenceAId));
    const [seqB] = await this.db.select({ id: sequences.id, name: sequences.name, status: sequences.status, mode: sequences.mode }).from(sequences).where(eq(sequences.id, row.sequenceBId));
    return { ...row, sequenceA: seqA ?? null, sequenceB: seqB ?? null };
  }

  async updateExperiment(
    workspaceId: string,
    id: string,
    patch: { name?: string; status?: string; weightA?: number; weightB?: number; primaryMetric?: string; durationDays?: number }
  ) {
    const existing = await this.getExperiment(workspaceId, id);
    if (!existing) return null;
    if (patch.status === "running") {
      if (existing.sequenceA?.status !== "active" || existing.sequenceB?.status !== "active") {
        throw new HttpError("Activate both A and B sequences before starting the experiment", 422);
      }
    }
    const [updated] = await this.db
      .update(sequenceExperiments)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.weightA !== undefined ? { weightA: patch.weightA } : {}),
        ...(patch.weightB !== undefined ? { weightB: patch.weightB } : {}),
        ...(patch.primaryMetric !== undefined ? { primaryMetric: patch.primaryMetric } : {}),
        ...(patch.durationDays !== undefined ? { durationDays: patch.durationDays } : {}),
        ...(patch.status === "running" && !existing.startedAt ? { startedAt: new Date() } : {}),
        ...(patch.status === "completed" || patch.status === "paused" ? { endedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(sequenceExperiments.id, id), eq(sequenceExperiments.workspaceId, workspaceId)))
      .returning();
    return updated ?? null;
  }

  async enrollExperiment(
    workspaceId: string,
    experimentId: string,
    input: { prospectIds?: string[]; listId?: string }
  ) {
    const experiment = await this.getExperiment(workspaceId, experimentId);
    if (!experiment) throw new HttpError("experiment_not_found", 404);
    if (experiment.status !== "running") {
      throw new HttpError("Experiment must be running before enrolling", 422, { status: experiment.status });
    }
    const idSet = new Set<string>(input.prospectIds ?? []);
    if (input.listId) {
      const members = await this.db
        .select({ prospectId: listMembers.prospectId })
        .from(listMembers)
        .where(eq(listMembers.listId, input.listId));
      for (const m of members) idSet.add(m.prospectId);
    }
    if (idSet.size === 0) throw new HttpError("No prospects to enroll", 422);

    const already = await this.db
      .select({ prospectId: sequenceEnrollments.prospectId })
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.experimentId, experimentId));
    const alreadySet = new Set(already.map((r) => r.prospectId));

    let enrolledA = 0;
    let enrolledB = 0;
    let skipped = 0;
    const newEnrollments: { enrollmentId: string; prospectId: string; firstStepScheduledAt: Date | null; variant: "A" | "B" }[] = [];

    for (const prospectId of idSet) {
      if (alreadySet.has(prospectId)) {
        skipped++;
        continue;
      }
      const variant = assignExperimentVariant(experimentId, prospectId, experiment.weightA, experiment.weightB);
      const sequenceId = variant === "A" ? experiment.sequenceAId : experiment.sequenceBId;
      const result = await this.enroll(sequenceId, workspaceId, {
        prospectIds: [prospectId],
        listId: input.listId,
        experimentId,
        experimentVariant: variant,
      });
      if (result.enrolled === 0) {
        skipped++;
        continue;
      }
      if (variant === "A") enrolledA++;
      else enrolledB++;
      const created = result.newEnrollments[0];
      if (created) newEnrollments.push({ ...created, variant });
    }

    return {
      enrolled: enrolledA + enrolledB,
      enrolledA,
      enrolledB,
      skipped,
      total: idSet.size,
      newEnrollments,
    };
  }

  async getExperimentAnalytics(workspaceId: string, experimentId: string) {
    const experiment = await this.getExperiment(workspaceId, experimentId);
    if (!experiment) return null;
    const rows = await this.db
      .select({
        variant: sequenceEnrollments.experimentVariant,
        status: sequenceEnrollments.status,
      })
      .from(sequenceEnrollments)
      .where(and(eq(sequenceEnrollments.experimentId, experimentId), eq(sequenceEnrollments.workspaceId, workspaceId)));

    const empty = { enrolled: 0, active: 0, completed: 0, replied: 0, bounced: 0, stopped: 0 };
    const byVariant: Record<"A" | "B", typeof empty> = {
      A: { ...empty },
      B: { ...empty },
    };
    for (const row of rows) {
      const key = row.variant === "B" ? "B" : "A";
      byVariant[key].enrolled++;
      if (row.status === "active") byVariant[key].active++;
      else if (row.status === "completed") byVariant[key].completed++;
      else if (row.status === "replied") byVariant[key].replied++;
      else if (row.status === "bounced") byVariant[key].bounced++;
      else byVariant[key].stopped++;
    }
    const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
    return {
      experiment,
      variants: {
        A: { ...byVariant.A, replyRate: rate(byVariant.A.replied, byVariant.A.enrolled), completionRate: rate(byVariant.A.completed + byVariant.A.replied, byVariant.A.enrolled) },
        B: { ...byVariant.B, replyRate: rate(byVariant.B.replied, byVariant.B.enrolled), completionRate: rate(byVariant.B.completed + byVariant.B.replied, byVariant.B.enrolled) },
      },
      primaryMetric: experiment.primaryMetric,
    };
  }
}

function validateSequenceForPublish(
  steps: { id: string; stepType: string; conditionType: string | null; conditionWaitDays: number; parentStepId: string | null; branch: string | null; yesNextStepId: string | null; noNextStepId: string | null }[]
) {
  const conditions = steps.filter((s) => s.stepType === "condition");
  for (const cond of conditions) {
    if ((cond.conditionWaitDays ?? 0) <= 0) {
      throw new HttpError(
        `Condition "${cond.conditionType ?? "unnamed"}" needs a timeout (wait days) before activating`,
        422
      );
    }
    const hasYes =
      Boolean(cond.yesNextStepId) ||
      steps.some((s) => s.parentStepId === cond.id && s.branch === "yes");
    const hasNo =
      Boolean(cond.noNextStepId) ||
      steps.some((s) => s.parentStepId === cond.id && s.branch === "no");
    if (!hasYes && !hasNo) {
      throw new HttpError(
        "Every condition needs a Yes or No fallback branch before activating",
        422
      );
    }
  }
}

async function wireConditionParents(
  db: Db,
  inputSteps: { branch?: "yes" | "no" | null; stepType: string }[],
  inserted: { id: string; stepType: string }[]
) {
  let current: { id: string; yes?: string; no?: string } | null = null;
  const persist = async () => {
    if (!current) return;
    await db
      .update(sequenceSteps)
      .set({
        yesNextStepId: current.yes ?? null,
        noNextStepId: current.no ?? null,
      })
      .where(eq(sequenceSteps.id, current.id));
  };

  for (let i = 0; i < inserted.length; i++) {
    const row = inserted[i]!;
    const spec = inputSteps[i]!;
    if (row.stepType === "condition") {
      await persist();
      current = { id: row.id };
      continue;
    }
    if (spec.branch && current) {
      await db
        .update(sequenceSteps)
        .set({ parentStepId: current.id, branch: spec.branch })
        .where(eq(sequenceSteps.id, row.id));
      inserted[i] = { ...row };
      if (spec.branch === "yes" && !current.yes) current.yes = row.id;
      if (spec.branch === "no" && !current.no) current.no = row.id;
      continue;
    }
    await persist();
    current = null;
  }
  await persist();
}

async function seedDefaultVariants(
  db: Db,
  stepId: string,
  subject: string | null,
  body: string | null
) {
  await db
    .insert(sequenceStepVariants)
    .values([
      { stepId, variantKey: "A", subject, bodyTemplate: body, weight: 50, enabled: true },
      { stepId, variantKey: "B", subject, bodyTemplate: body, weight: 50, enabled: true },
      { stepId, variantKey: "C", subject: null, bodyTemplate: null, weight: 0, enabled: false },
    ])
    .onConflictDoNothing();
}

async function upsertVariants(db: Db, stepId: string, variants: StepVariantInput[]) {
  for (const v of variants) {
    await db
      .insert(sequenceStepVariants)
      .values({
        stepId,
        variantKey: v.variantKey,
        subject: v.subject ?? null,
        bodyTemplate: v.bodyTemplate ?? null,
        weight: v.weight ?? (v.variantKey === "C" ? 0 : 50),
        enabled: v.enabled ?? v.variantKey !== "C",
      })
      .onConflictDoUpdate({
        target: [sequenceStepVariants.stepId, sequenceStepVariants.variantKey],
        set: {
          subject: v.subject ?? null,
          bodyTemplate: v.bodyTemplate ?? null,
          ...(v.weight !== undefined ? { weight: v.weight } : {}),
          ...(v.enabled !== undefined ? { enabled: v.enabled } : {}),
        },
      });
  }
}

export function buildSequenceService(db: Db | null): SequenceService | null {
  if (!db) return null;
  return new SequenceService(db);
}
