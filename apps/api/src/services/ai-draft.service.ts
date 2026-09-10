import { count, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo, scopedById } from "@skout/db";
import { HttpError } from "../utils/http.js";
import {
  getDraftAutoApproveSettings,
  getIcpScore,
  isOnAlwaysReviewList,
  passesAutoApproveThreshold,
} from "./draft-auto-approve.service.js";
import { resolveNotificationsForEntity } from "./notifications.service.js";

const { aiDrafts, prospectActivations, prospectScores } = schema;

export const AI_DRAFT_STATUSES = ["pending_review", "edited", "approved", "rejected", "sent"] as const;
export type AiDraftStatus = (typeof AI_DRAFT_STATUSES)[number];

export const REVIEWABLE_STATUSES: AiDraftStatus[] = ["pending_review", "edited"];

export interface AiDraftRow {
  id: string;
  workspaceId: string;
  prospectId: string;
  threadId: string | null;
  enrollmentStepId: string | null;
  subject: string;
  body: string;
  status: string;
  model: string | null;
  confidenceScore: string | null;
  autoApproved: boolean;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  prospectName?: string | null;
  prospectTitle?: string | null;
  companyName?: string | null;
  icpScore?: number | null;
}

function toDto(row: {
  id: string;
  workspaceId: string;
  prospectId: string;
  threadId: string | null;
  enrollmentStepId: string | null;
  subject: string;
  body: string;
  status: string;
  model: string | null;
  confidenceScore: string | null;
  autoApproved: boolean;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  prospectName?: string | null;
  prospectTitle?: string | null;
  companyName?: string | null;
  icpScore?: number | null;
}): AiDraftRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    prospectId: row.prospectId,
    threadId: row.threadId,
    enrollmentStepId: row.enrollmentStepId,
    subject: row.subject,
    body: row.body,
    status: row.status,
    model: row.model,
    confidenceScore: row.confidenceScore,
    autoApproved: row.autoApproved,
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
    reviewedBy: row.reviewedBy,
    prospectName: row.prospectName ?? null,
    prospectTitle: row.prospectTitle ?? null,
    companyName: row.companyName ?? null,
    icpScore: row.icpScore ?? null,
  };
}

export class AiDraftService {
  constructor(private readonly db: Db) {}

  async list(
    workspaceId: string,
    opts: { status?: AiDraftStatus; limit?: number; offset?: number } = {}
  ): Promise<{ data: AiDraftRow[]; total: number; workspaceId: string }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const where = scopedTo(aiDrafts, workspaceId, opts.status ? eq(aiDrafts.status, opts.status) : undefined);

    const [totalRow] = await this.db.select({ value: count() }).from(aiDrafts).where(where);
    const rows = await this.db
      .select({
        id: aiDrafts.id,
        workspaceId: aiDrafts.workspaceId,
        prospectId: aiDrafts.prospectId,
        threadId: aiDrafts.threadId,
        enrollmentStepId: aiDrafts.enrollmentStepId,
        subject: aiDrafts.subject,
        body: aiDrafts.body,
        status: aiDrafts.status,
        model: aiDrafts.model,
        confidenceScore: aiDrafts.confidenceScore,
        autoApproved: aiDrafts.autoApproved,
        createdAt: aiDrafts.createdAt,
        reviewedAt: aiDrafts.reviewedAt,
        reviewedBy: aiDrafts.reviewedBy,
        prospectName: sql<string | null>`${prospectActivations.snapshot}->>'fullName'`,
        prospectTitle: sql<string | null>`${prospectActivations.snapshot}->>'title'`,
        companyName: sql<string | null>`coalesce(${prospectActivations.snapshot}->>'companyName', ${prospectActivations.snapshot}->>'companyDomain')`,
        icpScore: prospectScores.score,
      })
      .from(aiDrafts)
      .leftJoin(
        prospectActivations,
        scopedTo(prospectActivations, aiDrafts.workspaceId, eq(prospectActivations.prospectId, aiDrafts.prospectId))
      )
      .leftJoin(
        prospectScores,
        scopedTo(prospectScores, aiDrafts.workspaceId, eq(prospectScores.prospectId, aiDrafts.prospectId))
      )
      .where(where)
      .orderBy(desc(aiDrafts.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      workspaceId,
      total: Number(totalRow?.value ?? 0),
      data: rows.map(toDto),
    };
  }

  async getById(workspaceId: string, id: string): Promise<AiDraftRow | null> {
    const [row] = await this.db
      .select({
        id: aiDrafts.id,
        workspaceId: aiDrafts.workspaceId,
        prospectId: aiDrafts.prospectId,
        threadId: aiDrafts.threadId,
        enrollmentStepId: aiDrafts.enrollmentStepId,
        subject: aiDrafts.subject,
        body: aiDrafts.body,
        status: aiDrafts.status,
        model: aiDrafts.model,
        confidenceScore: aiDrafts.confidenceScore,
        autoApproved: aiDrafts.autoApproved,
        createdAt: aiDrafts.createdAt,
        reviewedAt: aiDrafts.reviewedAt,
        reviewedBy: aiDrafts.reviewedBy,
        prospectName: sql<string | null>`${prospectActivations.snapshot}->>'fullName'`,
        prospectTitle: sql<string | null>`${prospectActivations.snapshot}->>'title'`,
        companyName: sql<string | null>`coalesce(${prospectActivations.snapshot}->>'companyName', ${prospectActivations.snapshot}->>'companyDomain')`,
        icpScore: prospectScores.score,
      })
      .from(aiDrafts)
      .leftJoin(
        prospectActivations,
        scopedTo(prospectActivations, aiDrafts.workspaceId, eq(prospectActivations.prospectId, aiDrafts.prospectId))
      )
      .leftJoin(
        prospectScores,
        scopedTo(prospectScores, aiDrafts.workspaceId, eq(prospectScores.prospectId, aiDrafts.prospectId))
      )
      .where(scopedById(aiDrafts, workspaceId, id))
      .limit(1);

    return row ? toDto(row) : null;
  }

  async create(
    workspaceId: string,
    input: {
      prospectId: string;
      subject: string;
      body: string;
      model?: string;
      confidenceScore?: string | number | null;
      threadId?: string | null;
      enrollmentStepId?: string | null;
      status?: AiDraftStatus;
      /** Opt this draft out of R13.2 auto-approve — e.g. Dexter's "stageForReview" chat action
       * is a deliberate always-human-review path, not eligible for the score/confidence bar. */
      skipAutoApprove?: boolean;
    }
  ): Promise<AiDraftRow> {
    // Auto-approve only ever applies to the default "pending_review" path — a caller that
    // explicitly asks for some other status (none do today) means something more specific.
    const requestedStatus = input.status ?? "pending_review";
    const { status, autoApproved } =
      requestedStatus === "pending_review" && !input.skipAutoApprove
        ? await this.resolveAutoApprove(workspaceId, input)
        : { status: requestedStatus, autoApproved: false };

    const [row] = await this.db
      .insert(aiDrafts)
      .values({
        workspaceId,
        prospectId: input.prospectId,
        subject: input.subject,
        body: input.body,
        model: input.model ?? null,
        confidenceScore:
          input.confidenceScore === undefined || input.confidenceScore === null
            ? null
            : String(input.confidenceScore),
        threadId: input.threadId ?? null,
        enrollmentStepId: input.enrollmentStepId ?? null,
        status,
        autoApproved,
      })
      .returning();
    return toDto(row!);
  }

  /**
   * R13.2 — auto-route: if the caller didn't force an explicit status, check the workspace's
   * auto-approve settings (ICP score + AI confidence threshold, minus an always-review list
   * escape hatch) and pre-approve the draft instead of leaving it for human review. Runs for
   * every caller of `create()` (manual generation, reply-suggestion auto-draft, ...) since
   * they all funnel through this one method.
   */
  private async resolveAutoApprove(
    workspaceId: string,
    input: { prospectId: string; confidenceScore?: string | number | null }
  ): Promise<{ status: AiDraftStatus; autoApproved: boolean }> {
    const fallback = { status: "pending_review" as AiDraftStatus, autoApproved: false };
    try {
      const settings = await getDraftAutoApproveSettings(this.db, workspaceId);
      if (!settings?.enabled) return fallback;

      const confidenceScore =
        input.confidenceScore === undefined || input.confidenceScore === null
          ? null
          : Number(input.confidenceScore);
      const icpScore = await getIcpScore(this.db, workspaceId, input.prospectId);

      if (!passesAutoApproveThreshold(settings, { icpScore, confidenceScore })) return fallback;
      if (await isOnAlwaysReviewList(this.db, input.prospectId, settings.alwaysReviewListIds)) return fallback;

      return { status: "approved", autoApproved: true };
    } catch {
      // Never let an auto-approve check failure block draft creation — fall back to review.
      return fallback;
    }
  }

  async update(
    workspaceId: string,
    id: string,
    patch: { subject?: string; body?: string },
    reviewedBy?: string
  ): Promise<AiDraftRow> {
    const existing = await this.requireDraft(workspaceId, id);
    if (!REVIEWABLE_STATUSES.includes(existing.status as AiDraftStatus) && existing.status !== "approved") {
      throw new HttpError(`Cannot edit a draft in status "${existing.status}"`, 422);
    }

    const [row] = await this.db
      .update(aiDrafts)
      .set({
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        status: "edited",
        reviewedAt: new Date(),
        reviewedBy: reviewedBy ?? existing.reviewedBy,
      })
      .where(scopedById(aiDrafts, workspaceId, id))
      .returning();

    return toDto(row!);
  }

  async approve(workspaceId: string, id: string, reviewedBy?: string): Promise<AiDraftRow> {
    const existing = await this.requireDraft(workspaceId, id);
    // Idempotent: already-approved drafts can be re-sent if SMTP failed previously.
    if (existing.status === "approved" || existing.status === "sent") {
      return existing;
    }
    return this.transition(workspaceId, id, "approved", reviewedBy);
  }

  async reject(workspaceId: string, id: string, reviewedBy?: string): Promise<AiDraftRow> {
    return this.transition(workspaceId, id, "rejected", reviewedBy);
  }

  /** After a successful SMTP send — status becomes `sent` and the inbox thread is linked. */
  async markSent(workspaceId: string, id: string, threadId: string): Promise<AiDraftRow> {
    const [row] = await this.db
      .update(aiDrafts)
      .set({
        status: "sent",
        threadId,
        reviewedAt: new Date(),
      })
      .where(scopedById(aiDrafts, workspaceId, id))
      .returning();
    if (!row) throw new HttpError("draft_not_found", 404);
    // No longer sitting in the review queue (R17.2) — resolve any pending stale-draft reminder.
    await resolveNotificationsForEntity(this.db, "ai_draft", id);
    return toDto(row);
  }

  async bulkApprove(
    workspaceId: string,
    ids: string[],
    reviewedBy?: string
  ): Promise<{ approved: number; skipped: number }> {
    if (ids.length === 0) return { approved: 0, skipped: 0 };
    const unique = [...new Set(ids)];
    const now = new Date();
    const updated = await this.db
      .update(aiDrafts)
      .set({
        status: "approved",
        reviewedAt: now,
        reviewedBy: reviewedBy ?? null,
      })
      .where(
        scopedTo(aiDrafts, workspaceId, inArray(aiDrafts.id, unique), inArray(aiDrafts.status, REVIEWABLE_STATUSES))
      )
      .returning({ id: aiDrafts.id });

    await Promise.all(updated.map((row) => resolveNotificationsForEntity(this.db, "ai_draft", row.id)));

    return { approved: updated.length, skipped: unique.length - updated.length };
  }

  private async transition(
    workspaceId: string,
    id: string,
    next: "approved" | "rejected",
    reviewedBy?: string
  ): Promise<AiDraftRow> {
    const existing = await this.requireDraft(workspaceId, id);
    if (!REVIEWABLE_STATUSES.includes(existing.status as AiDraftStatus)) {
      throw new HttpError(`Cannot ${next.replace(/ed$/, "")} a draft in status "${existing.status}"`, 422);
    }

    const [row] = await this.db
      .update(aiDrafts)
      .set({
        status: next,
        reviewedAt: new Date(),
        reviewedBy: reviewedBy ?? null,
      })
      .where(scopedById(aiDrafts, workspaceId, id))
      .returning();

    // No longer sitting in the review queue (R17.2) — resolve any pending stale-draft reminder.
    await resolveNotificationsForEntity(this.db, "ai_draft", id);

    return toDto(row!);
  }

  private async requireDraft(workspaceId: string, id: string): Promise<AiDraftRow> {
    const [row] = await this.db
      .select()
      .from(aiDrafts)
      .where(scopedById(aiDrafts, workspaceId, id))
      .limit(1);
    if (!row) throw new HttpError("draft_not_found", 404);
    return toDto(row);
  }
}

export function buildAiDraftService(db: Db) {
  return new AiDraftService(db);
}
