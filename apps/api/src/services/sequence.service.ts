import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "../utils/http.js";

const { sequences, sequenceSteps } = schema;

export const STEP_TYPES = ["email", "linkedin", "wait", "task"] as const;
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
  subject?: string;
  bodyTemplate?: string;
}

export interface UpdateStepInput {
  stepType?: StepType;
  delayDays?: number;
  subject?: string | null;
  bodyTemplate?: string | null;
}

export class SequenceService {
  constructor(private readonly db: Db) {}

  async listSequences(workspaceId: string) {
    return this.db
      .select()
      .from(sequences)
      .where(eq(sequences.workspaceId, workspaceId))
      .orderBy(sequences.createdAt);
  }

  async createSequence(workspaceId: string, name: string) {
    const [row] = await this.db
      .insert(sequences)
      .values({ workspaceId, name, status: "draft" })
      .returning();
    return row!;
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
    return updated!;
  }

  async deleteSequence(workspaceId: string, id: string) {
    await this.db
      .delete(sequences)
      .where(and(eq(sequences.id, id), eq(sequences.workspaceId, workspaceId)));
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

  async enroll(sequenceId: string, workspaceId: string) {
    return {
      sequenceId,
      workspaceId,
      status: "accepted" as const,
      message: "Enrollment workflow queued (Temporal stub)",
    };
  }
}

export function buildSequenceService(db: Db | null): SequenceService | null {
  if (!db) return null;
  return new SequenceService(db);
}
