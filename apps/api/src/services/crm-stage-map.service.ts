import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { HttpError } from "@skout/auth";

const { crmConnections, pipelines, pipelineStages, auditLogs } = schema;

/**
 * COPS-09: HubSpot deal stage id -> Skout pipeline stage id, kept on the connection
 * (settings.stageMap). A new deal pulled from HubSpot starts in the mapped stage. An existing
 * deal's stage is never changed by a pull: stage moves go through the transition service (COPS-02),
 * which records the reason and emits the lifecycle events a direct write would skip.
 */
export type CrmStageMap = Record<string, string>;

export async function getStageMap(db: Db, workspaceId: string, provider: string): Promise<CrmStageMap> {
  const [row] = await db
    .select({ settings: crmConnections.settings })
    .from(crmConnections)
    .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, provider)))
    .limit(1);
  const map = ((row?.settings ?? {}) as { stageMap?: unknown }).stageMap;
  if (!map || typeof map !== "object") return {};
  return Object.fromEntries(Object.entries(map as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** The workspace's pipelines with their stages, in board order. */
export async function listSkoutStages(db: Db, workspaceId: string) {
  const rows = await db
    .select({
      pipelineId: pipelines.id,
      pipelineName: pipelines.name,
      isDefault: pipelines.isDefault,
      stageId: pipelineStages.id,
      stageName: pipelineStages.name,
      orderIndex: pipelineStages.orderIndex,
    })
    .from(pipelines)
    .innerJoin(pipelineStages, eq(pipelineStages.pipelineId, pipelines.id))
    .where(and(eq(pipelines.workspaceId, workspaceId), isNull(pipelines.deletedAt)))
    .orderBy(asc(pipelines.name), asc(pipelineStages.orderIndex));
  return rows;
}

/** Replaces the stage map. Every Skout stage must be a stage of this workspace (422 otherwise). */
export async function saveStageMap(db: Db, workspaceId: string, provider: string, map: CrmStageMap, actorId?: string | null): Promise<CrmStageMap> {
  const stageIds = [...new Set(Object.values(map))];
  if (stageIds.length > 0) {
    const found = await db
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .innerJoin(pipelines, eq(pipelines.id, pipelineStages.pipelineId))
      .where(and(eq(pipelines.workspaceId, workspaceId), isNull(pipelines.deletedAt), inArray(pipelineStages.id, stageIds)));
    const known = new Set(found.map((f) => f.id));
    const unknown = stageIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new HttpError(`Not a stage of this workspace: ${unknown.join(", ")}`, 422);
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: crmConnections.id, settings: crmConnections.settings })
      .from(crmConnections)
      .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, provider)))
      .for("update")
      .limit(1);
    if (!row) throw new HttpError(`CRM connection for ${provider} not found`, 404);
    const settings = (row.settings ?? {}) as Record<string, unknown>;
    await tx.update(crmConnections).set({ settings: { ...settings, stageMap: map }, updatedAt: new Date() }).where(eq(crmConnections.id, row.id));
    await tx.insert(auditLogs).values({
      workspaceId,
      actorType: actorId ? "user" : "system",
      actorId: actorId ?? null,
      action: "crm_stage_map.updated",
      entityType: "crm_connection",
      entityId: row.id,
      beforeState: { stageMap: settings.stageMap ?? {} },
      afterState: { stageMap: map },
      reason: "CRM stage map updated",
    });
    return map;
  });
}

export type SkoutStageRow = Awaited<ReturnType<typeof listSkoutStages>>[number];

/**
 * The stage a new deal pulled from the provider starts in: the mapped stage when its provider
 * stage is mapped, else the first stage of the default pipeline (else of the first pipeline).
 * `stages` is listSkoutStages' result (board order).
 */
export function pickNewDealStage(
  stages: readonly SkoutStageRow[],
  map: CrmStageMap,
  providerStageId: string | null | undefined
): { pipelineId: string; stageId: string } | null {
  const mapped = providerStageId ? map[providerStageId] : undefined;
  const hit = mapped ? stages.find((s) => s.stageId === mapped) : undefined;
  if (hit) return { pipelineId: hit.pipelineId, stageId: hit.stageId };
  const first = stages.find((s) => s.isDefault) ?? stages[0];
  return first ? { pipelineId: first.pipelineId, stageId: first.stageId } : null;
}
