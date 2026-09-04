import { desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedById, scopedTo } from "@skout/db";
import type { EnrichField } from "@skout/pal";
import { HttpError } from "../utils/http.js";

const { enrichmentWorkbooks } = schema;

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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
 */
export async function activateWorkbook(
  db: Db,
  workspaceId: string,
  id: string
): Promise<EnrichmentWorkbookRecord> {
  const existing = await getWorkbook(db, workspaceId, id);
  if (!existing) throw new HttpError("workbook_not_found", 404);
  if (existing.status === "active") throw new HttpError("workbook_already_active", 409);

  const now = new Date();
  const [row] = await db
    .update(enrichmentWorkbooks)
    .set({ status: "active", activatedAt: now, updatedAt: now })
    .where(eq(enrichmentWorkbooks.id, id))
    .returning();
  return serialize(row!);
}
