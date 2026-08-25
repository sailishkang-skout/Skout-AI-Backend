import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { computeNextSendAt, type ReportCadence } from "./report-cadence.js";

const { reportSchedules } = schema;

export interface ReportScheduleRecord {
  id: string;
  workspaceId: string;
  name: string;
  cadence: ReportCadence;
  recipientEmails: string[];
  enabled: boolean;
  lastSentAt: string | null;
  nextSendAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function serialize(row: typeof reportSchedules.$inferSelect): ReportScheduleRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    cadence: row.cadence as ReportCadence,
    recipientEmails: row.recipientEmails,
    enabled: row.enabled,
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    nextSendAt: row.nextSendAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreateReportScheduleInput {
  name: string;
  cadence: ReportCadence;
  recipientEmails: string[];
  enabled?: boolean;
}

export async function createReportSchedule(
  db: Db,
  workspaceId: string,
  input: CreateReportScheduleInput
): Promise<ReportScheduleRecord> {
  const now = new Date();
  const enabled = input.enabled ?? true;
  const [row] = await db
    .insert(reportSchedules)
    .values({
      workspaceId,
      name: input.name,
      cadence: input.cadence,
      recipientEmails: input.recipientEmails,
      enabled,
      nextSendAt: enabled ? computeNextSendAt(input.cadence, now) : null,
    })
    .returning();
  return serialize(row!);
}

export async function listReportSchedules(db: Db, workspaceId: string): Promise<ReportScheduleRecord[]> {
  const rows = await db.select().from(reportSchedules).where(eq(reportSchedules.workspaceId, workspaceId));
  return rows.map(serialize);
}

export async function getReportSchedule(
  db: Db,
  workspaceId: string,
  id: string
): Promise<ReportScheduleRecord | null> {
  const [row] = await db
    .select()
    .from(reportSchedules)
    .where(and(eq(reportSchedules.id, id), eq(reportSchedules.workspaceId, workspaceId)));
  return row ? serialize(row) : null;
}

export interface UpdateReportScheduleInput {
  name?: string;
  cadence?: ReportCadence;
  recipientEmails?: string[];
  enabled?: boolean;
}

export async function updateReportSchedule(
  db: Db,
  workspaceId: string,
  id: string,
  patch: UpdateReportScheduleInput
): Promise<ReportScheduleRecord | null> {
  const existing = await getReportSchedule(db, workspaceId, id);
  if (!existing) return null;

  const cadence = patch.cadence ?? existing.cadence;
  const enabled = patch.enabled ?? existing.enabled;
  // Re-enabling or changing cadence both restart the clock from now, same as smart-list refresh scheduling.
  const cadenceChanged = patch.cadence !== undefined && patch.cadence !== existing.cadence;
  const justEnabled = patch.enabled === true && !existing.enabled;
  const nextSendAt = !enabled ? null : cadenceChanged || justEnabled ? computeNextSendAt(cadence, new Date()) : undefined;

  const [row] = await db
    .update(reportSchedules)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.cadence !== undefined ? { cadence: patch.cadence } : {}),
      ...(patch.recipientEmails !== undefined ? { recipientEmails: patch.recipientEmails } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(nextSendAt !== undefined ? { nextSendAt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(reportSchedules.id, id))
    .returning();
  return row ? serialize(row) : null;
}

export async function deleteReportSchedule(db: Db, workspaceId: string, id: string): Promise<boolean> {
  const existing = await getReportSchedule(db, workspaceId, id);
  if (!existing) return false;
  await db.delete(reportSchedules).where(eq(reportSchedules.id, id));
  return true;
}
