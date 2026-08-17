import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";

const { promotionCandidates, prospectActivations, workspaces } = schema;

interface ProspectSnapshotPreview {
  fullName?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  title?: string;
  linkedinUrl?: string;
  companyDomain?: string;
  industry?: string;
  employeeCount?: number;
  location?: string;
}

export interface PendingCandidateDto {
  id: string;
  prospectId: string;
  score: number;
  fullName: string | null;
  companyName: string | null;
  createdAt: string;
}

/**
 * Called from EnrichmentService's afterScore hook right after a score is written. Flags the
 * prospect as a promotion candidate when its score meets the workspace's threshold. Re-scoring
 * an already-`pending` candidate updates its score in place; `promoted`/`dismissed` candidates
 * are left alone so re-scoring can't silently resurrect a decision a rep already made.
 */
export async function flagIfQualified(
  db: Db,
  workspaceId: string,
  prospectId: string,
  score: number
): Promise<void> {
  const [workspace] = await db
    .select({ dealPromotionThreshold: workspaces.dealPromotionThreshold })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!workspace || score < workspace.dealPromotionThreshold) return;

  const [existing] = await db
    .select({ id: promotionCandidates.id, status: promotionCandidates.status })
    .from(promotionCandidates)
    .where(and(eq(promotionCandidates.workspaceId, workspaceId), eq(promotionCandidates.prospectId, prospectId)))
    .limit(1);

  if (existing) {
    if (existing.status === "pending") {
      await db
        .update(promotionCandidates)
        .set({ score, updatedAt: new Date() })
        .where(eq(promotionCandidates.id, existing.id));
    }
    return;
  }

  await db.insert(promotionCandidates).values({ workspaceId, prospectId, score, status: "pending" });
}

/** Pending candidates for the "Hot Prospects" panel, highest score first. */
export async function listPendingCandidates(db: Db, workspaceId: string): Promise<PendingCandidateDto[]> {
  const rows = await db
    .select({
      id: promotionCandidates.id,
      prospectId: promotionCandidates.prospectId,
      score: promotionCandidates.score,
      createdAt: promotionCandidates.createdAt,
      snapshot: prospectActivations.snapshot,
    })
    .from(promotionCandidates)
    .leftJoin(
      prospectActivations,
      and(
        eq(prospectActivations.workspaceId, promotionCandidates.workspaceId),
        eq(prospectActivations.prospectId, promotionCandidates.prospectId)
      )
    )
    .where(and(eq(promotionCandidates.workspaceId, workspaceId), eq(promotionCandidates.status, "pending")))
    .orderBy(desc(promotionCandidates.score));

  return rows.map((row) => {
    const snapshot = (row.snapshot ?? {}) as ProspectSnapshotPreview;
    return {
      id: row.id,
      prospectId: row.prospectId,
      score: row.score,
      fullName: snapshot.fullName ?? null,
      companyName: snapshot.companyName ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  });
}
