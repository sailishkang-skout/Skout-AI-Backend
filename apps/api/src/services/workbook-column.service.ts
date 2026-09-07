import { asc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo, scopedById } from "@skout/db";
import { HttpError } from "../utils/http.js";
import { extractTemplateKeys } from "./workbook-column-template.js";
import { getWorkbook } from "./workbook.service.js";

const { workbookColumnDefinitions, workbookColumnValues } = schema;

export const WORKBOOK_COLUMN_TYPES = ["derived", "ai_research"] as const;
export type WorkbookColumnType = (typeof WORKBOOK_COLUMN_TYPES)[number];

/** Built-in `{{key}}` references available to every column: the 4 fixed waterfall fields
 * (as they land in enrichmentResults/FieldResult — see workbook-column-compute.service.ts)
 * plus a couple of identity fields already present on every prospect snapshot. */
export const FIXED_TEMPLATE_KEYS = ["company", "email", "phone", "email_status", "fullName", "title", "companyDomain"] as const;

export interface DerivedColumnConfig {
  template: string;
}
export interface AiResearchColumnConfig {
  promptTemplate: string;
}
export type WorkbookColumnConfig = DerivedColumnConfig | AiResearchColumnConfig;

export interface WorkbookColumnRecord {
  id: string;
  workspaceId: string;
  workbookId: string;
  key: string;
  label: string;
  columnType: WorkbookColumnType;
  config: WorkbookColumnConfig;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

function serialize(row: typeof workbookColumnDefinitions.$inferSelect): WorkbookColumnRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workbookId: row.workbookId,
    key: row.key,
    label: row.label,
    columnType: row.columnType as WorkbookColumnType,
    config: row.config as WorkbookColumnConfig,
    orderIndex: row.orderIndex,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function templateOf(columnType: WorkbookColumnType, config: WorkbookColumnConfig): string {
  return columnType === "derived"
    ? (config as DerivedColumnConfig).template
    : (config as AiResearchColumnConfig).promptTemplate;
}

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export interface CreateColumnInput {
  key: string;
  label: string;
  columnType: WorkbookColumnType;
  config: WorkbookColumnConfig;
}

export async function listColumns(db: Db, workspaceId: string, workbookId: string): Promise<WorkbookColumnRecord[]> {
  const rows = await db
    .select()
    .from(workbookColumnDefinitions)
    .where(scopedTo(workbookColumnDefinitions, workspaceId, eq(workbookColumnDefinitions.workbookId, workbookId)))
    .orderBy(asc(workbookColumnDefinitions.orderIndex));
  return rows.map(serialize);
}

/**
 * Validates the column's template at creation time (per the design doc's open question #3:
 * "recommend validating at creation time — cheap, and avoids a workbook silently producing
 * all-failed cells for a typo'd reference"). A template may only reference a fixed field or an
 * *already-existing* column on this workbook — never itself or a column added later — which is
 * what makes forward-reference cycle detection unnecessary (see workbook-column-compute.service.ts).
 */
export async function createColumn(
  db: Db,
  workspaceId: string,
  workbookId: string,
  input: CreateColumnInput
): Promise<WorkbookColumnRecord> {
  const workbook = await getWorkbook(db, workspaceId, workbookId);
  if (!workbook) throw new HttpError("workbook_not_found", 404);

  if (!KEY_RE.test(input.key)) {
    throw new HttpError("invalid_column_key", 422, {
      message: "key must be lowercase letters, digits, underscores, starting with a letter",
    });
  }
  if (!WORKBOOK_COLUMN_TYPES.includes(input.columnType)) {
    throw new HttpError("invalid_column_type", 422);
  }

  const existing = await listColumns(db, workspaceId, workbookId);
  if (existing.some((c) => c.key === input.key)) {
    throw new HttpError("column_key_already_exists", 409);
  }

  const template = templateOf(input.columnType, input.config);
  const referenced = extractTemplateKeys(template);
  const knownKeys = new Set<string>([...FIXED_TEMPLATE_KEYS, ...existing.map((c) => c.key)]);
  const unknown = referenced.filter((key) => !knownKeys.has(key));
  if (unknown.length > 0) {
    throw new HttpError("unknown_template_reference", 422, {
      message: `Template references unknown or not-yet-created column(s): ${unknown.join(", ")}`,
      unknownKeys: unknown,
    });
  }

  const orderIndex = existing.length > 0 ? Math.max(...existing.map((c) => c.orderIndex)) + 1 : 0;

  const [row] = await db
    .insert(workbookColumnDefinitions)
    .values({
      workspaceId,
      workbookId,
      key: input.key,
      label: input.label,
      columnType: input.columnType,
      config: input.config,
      orderIndex,
    })
    .returning();
  return serialize(row!);
}

export async function deleteColumn(db: Db, workspaceId: string, workbookId: string, columnId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: workbookColumnDefinitions.id })
    .from(workbookColumnDefinitions)
    .where(
      scopedTo(
        workbookColumnDefinitions,
        workspaceId,
        eq(workbookColumnDefinitions.workbookId, workbookId),
        eq(workbookColumnDefinitions.id, columnId)
      )
    );
  if (!existing) return false;

  const allColumns = await listColumns(db, workspaceId, workbookId);
  const dependents = allColumns.filter((c) => c.id !== columnId);
  const target = allColumns.find((c) => c.id === columnId);
  if (target) {
    const stillReferenced = dependents.filter((c) => extractTemplateKeys(templateOf(c.columnType, c.config)).includes(target.key));
    if (stillReferenced.length > 0) {
      throw new HttpError("column_still_referenced", 409, {
        message: `Column "${target.key}" is still referenced by: ${stillReferenced.map((c) => c.key).join(", ")}`,
      });
    }
  }

  await db.delete(workbookColumnDefinitions).where(scopedById(workbookColumnDefinitions, workspaceId, columnId));
  return true;
}

export interface WorkbookColumnValueRecord {
  id: string;
  columnDefinitionId: string;
  prospectId: string;
  status: "pending" | "succeeded" | "failed";
  value: string | null;
  evidenceId: string | null;
  error: string | null;
  computedAt: string | null;
}

/** Every computed cell for one run, across all its flexible columns — the grid UI's data
 * source for the two new column types (fixed-field values still come from the existing
 * enrichmentResults/prospectActivations surface, unchanged). */
export async function getColumnValuesForRun(
  db: Db,
  workspaceId: string,
  workbookRunId: string
): Promise<WorkbookColumnValueRecord[]> {
  const rows = await db
    .select()
    .from(workbookColumnValues)
    .where(scopedTo(workbookColumnValues, workspaceId, eq(workbookColumnValues.workbookRunId, workbookRunId)));
  return rows.map((row) => ({
    id: row.id,
    columnDefinitionId: row.columnDefinitionId,
    prospectId: row.prospectId,
    status: row.status as WorkbookColumnValueRecord["status"],
    value: row.value,
    evidenceId: row.evidenceId,
    error: row.error,
    computedAt: row.computedAt?.toISOString() ?? null,
  }));
}
