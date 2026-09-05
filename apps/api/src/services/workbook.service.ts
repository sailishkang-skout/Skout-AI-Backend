import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedById, scopedTo } from "@skout/db";
import type { EnrichField } from "@skout/pal";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { buildListService } from "./list.service.js";
import { osConfigFromEnv } from "./smart-list.service.js";

const { enrichmentWorkbooks, enrichmentWorkbookRuns, enrichmentJobs } = schema;

export type WorkbookStatus = "draft" | "active";

export interface EnrichmentWorkbookRecord {
  id: string;
  workspaceId: string;
  name: string;
  fields: EnrichField[];
  emailQualityThreshold: number | null;
  budgetCreditsPerRun: number | null;
  status: WorkbookStatus;
  activatedAt: string | null;
  /** Static list activation materialized this workbook's result rows into (ADI-13). Null until activated. */
  resultListId: string | null;
  createdAt: string;
  updatedAt: string;
}

function serialize(row: typeof enrichmentWorkbooks.$inferSelect): EnrichmentWorkbookRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    fields: row.fields as EnrichField[],
    emailQualityThreshold: row.emailQualityThreshold != null ? Number(row.emailQualityThreshold) : null,
    budgetCreditsPerRun: row.budgetCreditsPerRun,
    status: row.status as WorkbookStatus,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    resultListId: row.resultListId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Distinct prospect IDs this workbook has ever successfully enriched, across all its runs. */
async function getWorkbookResultProspectIds(
  db: Db,
  workspaceId: string,
  workbookId: string
): Promise<string[]> {
  const runs = await db
    .select({ batchId: enrichmentWorkbookRuns.batchId })
    .from(enrichmentWorkbookRuns)
    .where(scopedTo(enrichmentWorkbookRuns, workspaceId, eq(enrichmentWorkbookRuns.workbookId, workbookId)));
  const batchIds = runs.map((r) => r.batchId).filter((id): id is string => id != null);
  if (batchIds.length === 0) return [];

  const completedJobs = await db
    .select({ prospectId: enrichmentJobs.prospectId })
    .from(enrichmentJobs)
    .where(and(inArray(enrichmentJobs.batchId, batchIds), eq(enrichmentJobs.status, "completed")));
  return [...new Set(completedJobs.map((j) => j.prospectId))];
}

export interface CreateWorkbookInput {
  name: string;
  fields: EnrichField[];
  emailQualityThreshold?: number;
  budgetCreditsPerRun?: number;
}

export async function createWorkbook(
  db: Db,
  workspaceId: string,
  input: CreateWorkbookInput
): Promise<EnrichmentWorkbookRecord> {
  const [row] = await db
    .insert(enrichmentWorkbooks)
    .values({
      workspaceId,
      name: input.name,
      fields: input.fields,
      emailQualityThreshold: input.emailQualityThreshold?.toString(),
      budgetCreditsPerRun: input.budgetCreditsPerRun ?? null,
      status: "draft",
    })
    .returning();
  return serialize(row!);
}

export async function listWorkbooks(db: Db, workspaceId: string): Promise<EnrichmentWorkbookRecord[]> {
  const rows = await db
    .select()
    .from(enrichmentWorkbooks)
    .where(scopedTo(enrichmentWorkbooks, workspaceId))
    .orderBy(desc(enrichmentWorkbooks.createdAt));
  return rows.map(serialize);
}

export async function getWorkbook(
  db: Db,
  workspaceId: string,
  id: string
): Promise<EnrichmentWorkbookRecord | null> {
  const [row] = await db
    .select()
    .from(enrichmentWorkbooks)
    .where(scopedById(enrichmentWorkbooks, workspaceId, id));
  return row ? serialize(row) : null;
}

export interface UpdateWorkbookInput {
  name?: string;
  fields?: EnrichField[];
  emailQualityThreshold?: number | null;
  budgetCreditsPerRun?: number | null;
}

export async function updateWorkbook(
  db: Db,
  workspaceId: string,
  id: string,
  patch: UpdateWorkbookInput
): Promise<EnrichmentWorkbookRecord | null> {
  const existing = await getWorkbook(db, workspaceId, id);
  if (!existing) return null;

  const [row] = await db
    .update(enrichmentWorkbooks)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.fields !== undefined ? { fields: patch.fields } : {}),
      ...(patch.emailQualityThreshold !== undefined
        ? { emailQualityThreshold: patch.emailQualityThreshold?.toString() ?? null }
        : {}),
      ...(patch.budgetCreditsPerRun !== undefined
        ? { budgetCreditsPerRun: patch.budgetCreditsPerRun }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(enrichmentWorkbooks.id, id))
    .returning();
  return row ? serialize(row) : null;
}

/**
 * Promotes a workbook from draft to active — an explicit, distinct step (8.3 Ask),
 * never an implicit side effect of running a sample. Only active workbooks may run
 * in a non-"sample" mode (see workbook-run.service.ts).
 *
 * ADI-13 (§8.3) — also makes the hand-off visible and traceable: materializes every
 * prospect this workbook has ever successfully enriched into a dedicated static list
 * (the same `lists`/`listMembers` primitive workbook runs read *from*, and the one
 * Sequence enrollment already accepts a `listId` for — a filter-driven Smart List can't
 * represent "this exact set of rows a run produced", so that model doesn't fit here).
 */
export async function activateWorkbook(
  db: Db,
  config: Env,
  workspaceId: string,
  id: string
): Promise<EnrichmentWorkbookRecord> {
  const existing = await getWorkbook(db, workspaceId, id);
  if (!existing) throw new HttpError("workbook_not_found", 404);
  if (existing.status === "active") throw new HttpError("workbook_already_active", 409);

  const listService = buildListService(db, osConfigFromEnv(config));
  const resultList = await listService!.createList(workspaceId, `${existing.name} — Results`);
  const prospectIds = await getWorkbookResultProspectIds(db, workspaceId, id);
  if (prospectIds.length > 0) {
    await listService!.addMembers(
      workspaceId,
      resultList.id,
      prospectIds.map((prospectId) => ({ prospectId }))
    );
  }

  const now = new Date();
  const [row] = await db
    .update(enrichmentWorkbooks)
    .set({ status: "active", activatedAt: now, updatedAt: now, resultListId: resultList.id })
    .where(eq(enrichmentWorkbooks.id, id))
    .returning();
  return serialize(row!);
}
