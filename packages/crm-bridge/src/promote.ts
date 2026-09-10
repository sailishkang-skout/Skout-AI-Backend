import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { upsertCompanyBySourceProspect, upsertContactBySourceProspect, type ProspectSnapshotPreview } from "./upsert.js";

const {
  promotionCandidates,
  prospectActivations,
  workspaces,
  deals,
  pipelines,
  pipelineStages,
  auditLogs,
} = schema;

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

  // onConflictDoNothing guards a concurrent scoring pass of the same prospect racing between
  // the select above and this insert — the unique(workspaceId, prospectId) constraint would
  // otherwise raise instead of silently no-opping (the next re-score reconciles the row anyway).
  await db
    .insert(promotionCandidates)
    .values({ workspaceId, prospectId, score, status: "pending" })
    .onConflictDoNothing({ target: [promotionCandidates.workspaceId, promotionCandidates.prospectId] });
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

export interface PromoteResult {
  companyId: string;
  contactId: string;
  dealId: string;
}

/**
 * Promotes a pending candidate into a real Company + Contact + Deal, matched/upserted by the
 * sourceProspectId/sourceProspectCompanyId correlation key. Never creates a pipeline itself —
 * the caller must call apps/crm's PipelinesService.ensureDefaultPipeline(workspaceId) first.
 */
export async function promoteProspectToDeal(
  db: Db,
  workspaceId: string,
  candidateId: string,
  actorId: string | undefined
): Promise<PromoteResult> {
  return db.transaction(async (tx) => {
    // Atomically claim the candidate — the WHERE clause only matches (and flips to "promoted")
    // a row still "pending", so two concurrent promote calls for the same candidate can't both
    // proceed to create a Company/Contact/Deal. The loser's UPDATE affects 0 rows.
    const [candidate] = await tx
      .update(promotionCandidates)
      .set({ status: "promoted", updatedAt: new Date() })
      .where(
        and(
          eq(promotionCandidates.id, candidateId),
          eq(promotionCandidates.workspaceId, workspaceId),
          eq(promotionCandidates.status, "pending")
        )
      )
      .returning();

    if (!candidate) {
      const [existing] = await tx
        .select({ id: promotionCandidates.id })
        .from(promotionCandidates)
        .where(and(eq(promotionCandidates.id, candidateId), eq(promotionCandidates.workspaceId, workspaceId)))
        .limit(1);
      if (!existing) throw new Error("promotion_candidate_not_found");
      throw new Error("promotion_candidate_already_promoted");
    }

    const [activation] = await tx
      .select({ snapshot: prospectActivations.snapshot })
      .from(prospectActivations)
      .where(
        and(
          eq(prospectActivations.workspaceId, workspaceId),
          eq(prospectActivations.prospectId, candidate.prospectId)
        )
      )
      .limit(1);
    const snapshot = (activation?.snapshot ?? {}) as ProspectSnapshotPreview;

    const { companyId, created: companyCreated, row: companyRow } = await upsertCompanyBySourceProspect(
      tx,
      workspaceId,
      candidate.prospectId,
      snapshot
    );
    if (companyCreated) {
      await tx.insert(auditLogs).values({
        workspaceId,
        actorId: actorId ?? null,
        action: "promotion",
        entityType: "company",
        entityId: companyId,
        beforeState: null,
        afterState: companyRow,
      });
    }

    const { contactId, created: contactCreated, row: contactRow } = await upsertContactBySourceProspect(
      tx,
      workspaceId,
      candidate.prospectId,
      companyId,
      snapshot
    );
    if (contactCreated) {
      await tx.insert(auditLogs).values({
        workspaceId,
        actorId: actorId ?? null,
        action: "promotion",
        entityType: "contact",
        entityId: contactId,
        beforeState: null,
        afterState: contactRow,
      });
    }

    const [defaultPipeline] = await tx
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.workspaceId, workspaceId), eq(pipelines.isDefault, true)))
      .limit(1);
    if (!defaultPipeline) throw new Error("default_pipeline_missing");

    // No .limit(1) here — takes the first of the ordered rows via destructuring, same as
    // listPendingCandidates above.
    const [firstStage] = await tx
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, defaultPipeline.id))
      .orderBy(pipelineStages.orderIndex);
    if (!firstStage) throw new Error("default_pipeline_missing");

    const [deal] = await tx
      .insert(deals)
      .values({
        workspaceId,
        companyId,
        pipelineId: defaultPipeline.id,
        stageId: firstStage.id,
        ownerId: actorId ?? null,
        name: `${snapshot.companyName ?? snapshot.fullName ?? "New"} — promoted lead`,
        currency: "USD",
      })
      .returning();
    await tx.insert(auditLogs).values({
      workspaceId,
      actorId: actorId ?? null,
      action: "promotion",
      entityType: "deal",
      entityId: deal.id,
      beforeState: null,
      afterState: deal,
    });

    return { companyId, contactId, dealId: deal.id };
  });
}
