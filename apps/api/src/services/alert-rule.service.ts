import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "../utils/http.js";

const { alertRules } = schema;

export interface AlertRuleDto {
  id: string;
  workspaceId: string;
  signalType: string;
  minConfidence: number | null;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDto(row: typeof alertRules.$inferSelect): AlertRuleDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    signalType: row.signalType,
    minConfidence: row.minConfidence,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listAlertRules(db: Db, workspaceId: string): Promise<AlertRuleDto[]> {
  const rows = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.workspaceId, workspaceId))
    .orderBy(desc(alertRules.createdAt));
  return rows.map(toDto);
}

export async function createAlertRule(
  db: Db,
  workspaceId: string,
  input: { signalType: string; minConfidence?: number | null; enabled?: boolean },
  createdBy?: string
): Promise<AlertRuleDto> {
  if (!input.signalType?.trim()) throw new HttpError("signalType is required", 422);
  const [row] = await db
    .insert(alertRules)
    .values({
      workspaceId,
      signalType: input.signalType.trim(),
      minConfidence: input.minConfidence ?? null,
      enabled: input.enabled ?? true,
      createdBy: createdBy ?? null,
    })
    .returning();
  return toDto(row!);
}

export async function updateAlertRule(
  db: Db,
  workspaceId: string,
  id: string,
  patch: { signalType?: string; minConfidence?: number | null; enabled?: boolean }
): Promise<AlertRuleDto> {
  const [row] = await db
    .update(alertRules)
    .set({
      ...(patch.signalType !== undefined ? { signalType: patch.signalType } : {}),
      ...(patch.minConfidence !== undefined ? { minConfidence: patch.minConfidence } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(alertRules.id, id), eq(alertRules.workspaceId, workspaceId)))
    .returning();
  if (!row) throw new HttpError("alert_rule_not_found", 404);
  return toDto(row);
}

export async function deleteAlertRule(db: Db, workspaceId: string, id: string): Promise<void> {
  await db.delete(alertRules).where(and(eq(alertRules.id, id), eq(alertRules.workspaceId, workspaceId)));
}
