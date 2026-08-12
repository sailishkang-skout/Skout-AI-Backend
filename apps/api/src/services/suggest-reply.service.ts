import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { AiDraftService } from "./ai-draft.service.js";

const log = createLogger("suggest-reply.service");
const {
  inboxThreads,
  inboxMessages,
  prospectActivations,
  prospectScores,
  sequenceEnrollments,
  sequences,
  aiDrafts,
} = schema;

const PAUSED_ENROLLMENT_STATUSES = new Set([
  "replied",
  "bounced",
  "completed",
  "paused",
  "stopped",
]);

export interface SuggestReplyResult {
  threadId: string;
  subject: string;
  body: string;
  confidence: number;
  source: "llm" | "heuristic";
  rationale: string | null;
  draftId: string | null;
  sequencePaused: boolean;
  enrollmentStatus: string | null;
  sequenceName: string | null;
}

function heuristicFallback(opts: {
  threadId: string;
  subject: string;
  prospectName?: string | null;
  replyTag?: string | null;
  lastInbound?: string | null;
}): Omit<SuggestReplyResult, "draftId" | "sequencePaused" | "enrollmentStatus" | "sequenceName"> {
  const name = (opts.prospectName || "there").split(/\s+/)[0] ?? "there";
  const tag = (opts.replyTag || "").toLowerCase();
  let subject = opts.subject || "Re: following up";
  if (!subject.toLowerCase().startsWith("re:")) subject = `Re: ${subject}`;

  if (tag === "meeting_request") {
    return {
      threadId: opts.threadId,
      subject,
      body: `Hi ${name},\n\nHappy to connect — what times work well for you this week?\n\nBest regards`,
      confidence: 0.55,
      source: "heuristic",
      rationale: "Heuristic: meeting_request tag",
    };
  }
  if (tag === "unsubscribe" || tag === "negative") {
    return {
      threadId: opts.threadId,
      subject,
      body: `Hi ${name},\n\nUnderstood — thanks for letting me know. I'll make sure we don't follow up further.\n\nBest regards`,
      confidence: 0.6,
      source: "heuristic",
      rationale: `Heuristic: ${tag} tag`,
    };
  }
  const snippet = opts.lastInbound ? ` regarding "${opts.lastInbound.slice(0, 120)}"` : "";
  return {
    threadId: opts.threadId,
    subject,
    body: `Hi ${name},\n\nThanks for your note${snippet}. Happy to share more detail or find a time that works for you.\n\nBest regards`,
    confidence: 0.4,
    source: "heuristic",
    rationale: "Heuristic: generic reply",
  };
}

export class SuggestReplyService {
  constructor(
    private readonly db: Db,
    private readonly config: Env
  ) {}

  async suggestForThread(
    workspaceId: string,
    threadId: string,
    opts: { persistDraft?: boolean } = {}
  ): Promise<SuggestReplyResult> {
    const persistDraft = opts.persistDraft !== false;

    const [thread] = await this.db
      .select()
      .from(inboxThreads)
      .where(and(eq(inboxThreads.workspaceId, workspaceId), eq(inboxThreads.id, threadId)))
      .limit(1);
    if (!thread) throw new HttpError("thread_not_found", 404);

    const messages = await this.db
      .select({
        direction: inboxMessages.direction,
        bodyText: inboxMessages.bodyText,
        fromAddress: inboxMessages.fromAddress,
      })
      .from(inboxMessages)
      .where(eq(inboxMessages.threadId, threadId))
      .orderBy(asc(inboxMessages.sentAt))
      .limit(20);

    let prospectName: string | null = null;
    let prospectTitle: string | null = null;
    let companyName: string | null = null;
    let companyDomain: string | null = null;
    let icpScore: number | null = null;

    if (thread.prospectId) {
      const [activation] = await this.db
        .select({ snapshot: prospectActivations.snapshot })
        .from(prospectActivations)
        .where(
          and(
            eq(prospectActivations.workspaceId, workspaceId),
            eq(prospectActivations.prospectId, thread.prospectId)
          )
        )
        .limit(1);
      const snap = (activation?.snapshot ?? {}) as Record<string, unknown>;
      prospectName = (snap.fullName as string) ?? null;
      prospectTitle = (snap.title as string) ?? null;
      companyName = (snap.companyName as string) ?? null;
      companyDomain = (snap.companyDomain as string) ?? null;

      const [score] = await this.db
        .select({ score: prospectScores.score })
        .from(prospectScores)
        .where(
          and(
            eq(prospectScores.workspaceId, workspaceId),
            eq(prospectScores.prospectId, thread.prospectId)
          )
        )
        .limit(1);
      icpScore = score?.score ?? null;
    }

    let enrollmentStatus: string | null = null;
    let sequenceName: string | null = null;
    if (thread.enrollmentId) {
      const [row] = await this.db
        .select({
          enrollmentStatus: sequenceEnrollments.status,
          sequenceName: sequences.name,
        })
        .from(sequenceEnrollments)
        .innerJoin(sequences, eq(sequences.id, sequenceEnrollments.sequenceId))
        .where(eq(sequenceEnrollments.id, thread.enrollmentId))
        .limit(1);
      enrollmentStatus = row?.enrollmentStatus ?? null;
      sequenceName = row?.sequenceName ?? null;
    }

    const sequencePaused =
      enrollmentStatus != null && PAUSED_ENROLLMENT_STATUSES.has(enrollmentStatus);

    const payload = {
      thread_id: threadId,
      prospect_id: thread.prospectId ?? undefined,
      prospect_name: prospectName ?? undefined,
      prospect_title: prospectTitle ?? undefined,
      company_name: companyName ?? undefined,
      company_domain: companyDomain ?? undefined,
      icp_score: icpScore ?? undefined,
      reply_tag: thread.replyTag ?? undefined,
      subject: thread.subject,
      messages: messages.map((m) => ({
        direction: m.direction,
        body: (m.bodyText ?? "").slice(0, 2000),
        from_address: m.fromAddress,
      })),
    };

    let draft = heuristicFallback({
      threadId,
      subject: thread.subject,
      prospectName,
      replyTag: thread.replyTag,
      lastInbound: [...messages].reverse().find((m) => m.direction === "inbound")?.bodyText,
    });

    const aiUrl = this.config.AI_SERVICE_URL?.trim();
    if (aiUrl) {
      try {
        const res = await fetch(`${aiUrl.replace(/\/$/, "")}/v1/suggest-reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            subject?: string;
            body?: string;
            confidence?: number;
            source?: string;
            rationale?: string | null;
          };
          if (data.body?.trim()) {
            draft = {
              threadId,
              subject: data.subject?.trim() || draft.subject,
              body: data.body.trim(),
              confidence:
                typeof data.confidence === "number" ? data.confidence : draft.confidence,
              source: data.source === "llm" ? "llm" : "heuristic",
              rationale: data.rationale ?? null,
            };
          }
        } else {
          log.warn("suggest-reply: AI service non-OK", { status: res.status, threadId });
        }
      } catch (err) {
        log.warn("suggest-reply: AI service call failed — using heuristic", { err, threadId });
      }
    }

    let draftId: string | null = null;
    if (persistDraft && thread.prospectId) {
      const drafts = new AiDraftService(this.db);
      // Replace any prior pending reply draft for this thread so the queue stays clean.
      const existing = await this.db
        .select({ id: aiDrafts.id })
        .from(aiDrafts)
        .where(
          and(
            eq(aiDrafts.workspaceId, workspaceId),
            eq(aiDrafts.threadId, threadId),
            eq(aiDrafts.status, "pending_review")
          )
        )
        .orderBy(desc(aiDrafts.createdAt))
        .limit(5);
      for (const row of existing) {
        await this.db
          .update(aiDrafts)
          .set({ status: "rejected", reviewedAt: new Date() })
          .where(eq(aiDrafts.id, row.id));
      }

      // create() may auto-approve this draft against the workspace's R13.2 thresholds (visible
      // in the review queue as auto-approved either way), but it's never auto-sent here —
      // sendApprovedDraftEmail always opens a brand-new thread, which is wrong for a reply
      // that must land in this existing thread. Sending stays a manual/reply-flow action.
      const created = await drafts.create(workspaceId, {
        prospectId: thread.prospectId,
        subject: draft.subject,
        body: draft.body,
        model: draft.source,
        confidenceScore: draft.confidence,
        threadId,
        status: "pending_review",
      });
      draftId = created.id;
    }

    return {
      ...draft,
      draftId,
      sequencePaused,
      enrollmentStatus,
      sequenceName,
    };
  }
}
