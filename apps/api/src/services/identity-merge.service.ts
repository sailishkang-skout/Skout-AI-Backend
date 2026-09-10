import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo, scopedById } from "@skout/db";
import { MERGE_PROPOSAL_MIN_SCORE, scoreCandidateMatch, type MatchCandidate } from "@skout/shared";
import { HttpError } from "@skout/auth";

const { identityMergeProposals, identityMergeEvents } = schema;

export interface ProposeMergeInput {
  workspaceId: string;
  entityType: string;
  leftEntityId: string;
  rightEntityId: string;
  left: MatchCandidate;
  right: MatchCandidate;
}

/**
 * §5.2 — score a candidate pair and, only if it clears MERGE_PROPOSAL_MIN_SCORE, create a
 * reviewed proposal. Never merges anything — a human always approves via resolveMergeProposal.
 * Returns null (not an error) when the pair doesn't clear the threshold, since "not similar
 * enough to propose" is an expected, common outcome.
 */
export async function proposeMerge(db: Db, input: ProposeMergeInput) {
  const { score, signals } = scoreCandidateMatch(input.left, input.right);
  if (score < MERGE_PROPOSAL_MIN_SCORE) return null;

  const [row] = await db
    .insert(identityMergeProposals)
    .values({
      workspaceId: input.workspaceId,
      entityType: input.entityType,
      leftEntityId: input.leftEntityId,
      rightEntityId: input.rightEntityId,
      score,
      signals,
    })
    .returning();
  return row;
}

export async function listPendingMergeProposals(db: Db, workspaceId: string) {
  return db
    .select()
    .from(identityMergeProposals)
    .where(scopedTo(identityMergeProposals, workspaceId, eq(identityMergeProposals.status, "pending")));
}

export interface ResolveMergeInput {
  workspaceId: string;
  proposalId: string;
  reviewerId: string;
  decision: "approved" | "rejected";
  /** Required when decision === "approved" — the pre-merge state of both records, so the merge is reversible later via reverseMergeEvent. */
  beforeSnapshot?: unknown;
}

/**
 * Approves or rejects a pending proposal. Approval also writes an identity_merge_events row
 * carrying beforeSnapshot — this is what makes the merge reversible; resolveMergeProposal does
 * not itself touch the underlying entity records (the caller applies the merge to its own
 * domain data after this returns, then can reverse it later via reverseMergeEvent if needed).
 */
export async function resolveMergeProposal(db: Db, input: ResolveMergeInput) {
  const [proposal] = await db
    .select()
    .from(identityMergeProposals)
    .where(scopedById(identityMergeProposals, input.workspaceId, input.proposalId));
  if (!proposal) throw new HttpError("proposal_not_found", 404);
  if (proposal.status !== "pending") throw new HttpError("proposal_already_resolved", 409, { status: proposal.status });

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(identityMergeProposals)
      .set({ status: input.decision, reviewedBy: input.reviewerId, reviewedAt: new Date() })
      .where(eq(identityMergeProposals.id, input.proposalId))
      .returning();

    if (input.decision === "approved") {
      if (!input.beforeSnapshot) throw new HttpError("before_snapshot_required", 400);
      await tx.insert(identityMergeEvents).values({
        workspaceId: input.workspaceId,
        proposalId: input.proposalId,
        entityType: proposal.entityType,
        action: "merge",
        primaryEntityId: proposal.leftEntityId,
        mergedEntityId: proposal.rightEntityId,
        beforeSnapshot: input.beforeSnapshot as object,
        performedBy: input.reviewerId,
      });
    }

    return updated;
  });
}

/**
 * Marks a merge event reversed and returns its beforeSnapshot for the caller to re-apply to
 * the actual entity records — this function only manages the audit/reversal bookkeeping, not
 * the domain-specific "how do I un-merge a company record" logic, which is caller-specific.
 */
export async function reverseMergeEvent(db: Db, workspaceId: string, eventId: string, _performedBy: string) {
  const [event] = await db
    .select()
    .from(identityMergeEvents)
    .where(scopedById(identityMergeEvents, workspaceId, eventId));
  if (!event) throw new HttpError("merge_event_not_found", 404);
  if (event.reversedAt) throw new HttpError("merge_event_already_reversed", 409);

  await db.update(identityMergeEvents).set({ reversedAt: new Date() }).where(eq(identityMergeEvents.id, eventId));
  return event.beforeSnapshot;
}
