import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";

const { draftAutoApproveSettings, listMembers, prospectScores } = schema;

export interface DraftAutoApproveSettingsDto {
  workspaceId: string;
  enabled: boolean;
  minIcpScore: number | null;
  minConfidence: number | null;
  alwaysReviewListIds: string[];
  updatedBy: string | null;
  updatedAt: string;
}

function toDto(row: typeof draftAutoApproveSettings.$inferSelect): DraftAutoApproveSettingsDto {
  return {
    workspaceId: row.workspaceId,
    enabled: row.enabled,
    minIcpScore: row.minIcpScore,
    minConfidence: row.minConfidence,
    alwaysReviewListIds: (row.alwaysReviewListIds as string[]) ?? [],
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getDraftAutoApproveSettings(
  db: Db,
  workspaceId: string
): Promise<DraftAutoApproveSettingsDto | null> {
  const [row] = await db
    .select()
    .from(draftAutoApproveSettings)
    .where(eq(draftAutoApproveSettings.workspaceId, workspaceId))
    .limit(1);
  return row ? toDto(row) : null;
}

export async function setDraftAutoApproveSettings(
  db: Db,
  workspaceId: string,
  input: {
    enabled: boolean;
    minIcpScore?: number | null;
    minConfidence?: number | null;
    alwaysReviewListIds?: string[];
  },
  updatedBy?: string
): Promise<DraftAutoApproveSettingsDto> {
  const [row] = await db
    .insert(draftAutoApproveSettings)
    .values({
      workspaceId,
      enabled: input.enabled,
      minIcpScore: input.minIcpScore ?? null,
      minConfidence: input.minConfidence ?? null,
      alwaysReviewListIds: input.alwaysReviewListIds ?? [],
      updatedBy: updatedBy ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: draftAutoApproveSettings.workspaceId,
      set: {
        enabled: input.enabled,
        minIcpScore: input.minIcpScore ?? null,
        minConfidence: input.minConfidence ?? null,
        alwaysReviewListIds: input.alwaysReviewListIds ?? [],
        updatedBy: updatedBy ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return toDto(row!);
}

/**
 * R13.2 — does this draft clear the workspace's auto-approve bar? Pure decision function so
 * both `AiDraftService.create()` and tests can exercise it without touching the DB.
 */
export function passesAutoApproveThreshold(
  settings: Pick<DraftAutoApproveSettingsDto, "enabled" | "minIcpScore" | "minConfidence">,
  draft: { icpScore: number | null; confidenceScore: number | null }
): boolean {
  if (!settings.enabled) return false;
  if (settings.minIcpScore != null && (draft.icpScore == null || draft.icpScore < settings.minIcpScore)) {
    return false;
  }
  if (
    settings.minConfidence != null &&
    (draft.confidenceScore == null || draft.confidenceScore < settings.minConfidence)
  ) {
    return false;
  }
  return true;
}

/** Is this prospect on any of the workspace's always-review lists (auto-approve bypass)? */
export async function isOnAlwaysReviewList(
  db: Db,
  prospectId: string,
  alwaysReviewListIds: string[]
): Promise<boolean> {
  if (alwaysReviewListIds.length === 0) return false;
  const [row] = await db
    .select({ listId: listMembers.listId })
    .from(listMembers)
    .where(and(eq(listMembers.prospectId, prospectId), inArray(listMembers.listId, alwaysReviewListIds)))
    .limit(1);
  return row != null;
}

export async function getIcpScore(db: Db, workspaceId: string, prospectId: string): Promise<number | null> {
  const [row] = await db
    .select({ score: prospectScores.score })
    .from(prospectScores)
    .where(and(eq(prospectScores.workspaceId, workspaceId), eq(prospectScores.prospectId, prospectId)))
    .limit(1);
  return row?.score ?? null;
}
