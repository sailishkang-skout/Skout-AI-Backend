import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";

const { dexterPlans, sequences, sequenceEnrollments, inboxThreads } = schema;

/** Thread states that represent a genuine human reply for rate purposes. Distinct from
 * 'bounced' (delivery failure, not a reply) and 'new' (no reply yet). 'closed' can include
 * non-reply closes (e.g. an unsubscribe) — a known v1 simplification, refinable later using
 * inboxMessages.direction === 'inbound' for more precision if it matters. */
const REPLIED_THREAD_STATUSES = ["replied", "meeting_booked", "closed"] as const;

export type DexterPlanDecision = "pending" | "accepted" | "rejected";

export interface DexterPlanMetrics {
  decision: DexterPlanDecision;
  decidedAt: Date | null;
  linkedSequenceIds: string[];
  enrollmentCount: number;
  /** null = no linked sequence yet, not "zero replies". */
  replyRate: number | null;
  /** null = no linked sequence yet, not "zero meetings". */
  meetingRate: number | null;
}

function decisionForStatus(status: string): DexterPlanDecision {
  if (status === "rejected") return "rejected";
  if (status === "approved" || status === "invoked" || status === "learned") return "accepted";
  return "pending";
}

/**
 * §7.3 Evaluation Loop — scores one Dexter plan against its original hypothesis. Reads
 * dexterPlans directly (the source of truth) rather than replaying the BullMQ event spine,
 * which isn't a durable log (jobs are pruned via removeOnComplete/removeOnFail).
 */
export async function computeDexterPlanMetrics(
  db: Db,
  workspaceId: string,
  planId: string
): Promise<DexterPlanMetrics | null> {
  const [plan] = await db
    .select()
    .from(dexterPlans)
    .where(and(eq(dexterPlans.id, planId), eq(dexterPlans.workspaceId, workspaceId)))
    .limit(1);
  if (!plan) return null;

  const decision = decisionForStatus(plan.status);
  const decidedAt = plan.approvedAt ?? plan.rejectedAt ?? null;

  const linkedSequences = await db
    .select({ id: sequences.id })
    .from(sequences)
    .where(and(eq(sequences.dexterPlanId, planId), eq(sequences.workspaceId, workspaceId)));

  if (linkedSequences.length === 0) {
    return {
      decision,
      decidedAt,
      linkedSequenceIds: [],
      enrollmentCount: 0,
      replyRate: null,
      meetingRate: null,
    };
  }

  const sequenceIds = linkedSequences.map((s) => s.id);
  const enrollments = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(and(inArray(sequenceEnrollments.sequenceId, sequenceIds), eq(sequenceEnrollments.workspaceId, workspaceId)));

  const enrollmentCount = enrollments.length;
  if (enrollmentCount === 0) {
    return {
      decision,
      decidedAt,
      linkedSequenceIds: sequenceIds,
      enrollmentCount: 0,
      replyRate: null,
      meetingRate: null,
    };
  }

  const enrollmentIds = enrollments.map((e) => e.id);
  const threads = await db
    .select({ enrollmentId: inboxThreads.enrollmentId, status: inboxThreads.status })
    .from(inboxThreads)
    .where(and(inArray(inboxThreads.enrollmentId, enrollmentIds), eq(inboxThreads.workspaceId, workspaceId)));

  const repliedEnrollments = new Set<string>();
  const meetingEnrollments = new Set<string>();
  for (const t of threads) {
    if (!t.enrollmentId) continue;
    if ((REPLIED_THREAD_STATUSES as readonly string[]).includes(t.status)) repliedEnrollments.add(t.enrollmentId);
    if (t.status === "meeting_booked") meetingEnrollments.add(t.enrollmentId);
  }

  return {
    decision,
    decidedAt,
    linkedSequenceIds: sequenceIds,
    enrollmentCount,
    replyRate: repliedEnrollments.size / enrollmentCount,
    meetingRate: meetingEnrollments.size / enrollmentCount,
  };
}

export interface DexterWorkspaceEvaluationSummary {
  acceptedCount: number;
  rejectedCount: number;
  pendingCount: number;
  /** null when no plan has been decided yet (nothing to rate). */
  acceptedRate: number | null;
}

/** Workspace-wide accepted-vs-overridden rate, for the command center's summary block. */
export async function computeWorkspaceEvaluationSummary(
  db: Db,
  workspaceId: string
): Promise<DexterWorkspaceEvaluationSummary> {
  const plans = await db.select({ status: dexterPlans.status }).from(dexterPlans).where(eq(dexterPlans.workspaceId, workspaceId));

  let acceptedCount = 0;
  let rejectedCount = 0;
  let pendingCount = 0;
  for (const p of plans) {
    const decision = decisionForStatus(p.status);
    if (decision === "accepted") acceptedCount++;
    else if (decision === "rejected") rejectedCount++;
    else pendingCount++;
  }

  const decidedCount = acceptedCount + rejectedCount;
  return {
    acceptedCount,
    rejectedCount,
    pendingCount,
    acceptedRate: decidedCount > 0 ? acceptedCount / decidedCount : null,
  };
}
