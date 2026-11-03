import { eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { COPS_PHASE1_EVENTS } from "@skout/shared";
import { writeCopsAudit } from "./cops-platform.service.js";

/**
 * COPS-14 configurable warehouse export with tenant privacy: each workspace decides whether its
 * events go to the analytics warehouse, and which types. The feed asks this before sending.
 */
const { copsExportSettings } = schema;

export const EXPORTABLE_EVENT_TYPES = Object.keys(COPS_PHASE1_EVENTS).sort();

export interface ExportSetting {
  enabled: boolean;
  eventTypes: string[] | null;
}
export const DEFAULT_EXPORT: ExportSetting = { enabled: true, eventTypes: null };

/** Pure: may this event of this workspace leave for the warehouse? */
export function exportAllowed(setting: ExportSetting | undefined, eventType: string): boolean {
  const s = setting ?? DEFAULT_EXPORT;
  if (!s.enabled) return false;
  return s.eventTypes === null || s.eventTypes.includes(eventType);
}

export async function exportSettingsFor(db: Db, workspaceIds: string[]): Promise<Map<string, ExportSetting>> {
  const ids = [...new Set(workspaceIds)];
  if (!ids.length) return new Map();
  const rows = await db.select().from(copsExportSettings).where(inArray(copsExportSettings.workspaceId, ids));
  return new Map(rows.map((r) => [r.workspaceId, { enabled: r.enabled, eventTypes: (r.eventTypes as string[] | null) ?? null }]));
}

export async function getExportSettings(db: Db, workspaceId: string) {
  const [row] = await db.select().from(copsExportSettings).where(eq(copsExportSettings.workspaceId, workspaceId)).limit(1);
  return {
    enabled: row?.enabled ?? true,
    event_types: (row?.eventTypes as string[] | null) ?? null,
    updated_at: row?.updatedAt ?? null,
    available_event_types: EXPORTABLE_EVENT_TYPES,
  };
}

export async function setExportSettings(
  db: Db,
  ctx: { workspaceId: string; userId: string; requestId: string },
  input: { enabled: boolean; event_types: string[] | null; reason: string }
) {
  const unknown = (input.event_types ?? []).filter((t) => !EXPORTABLE_EVENT_TYPES.includes(t));
  if (unknown.length) throw Object.assign(new Error(`Unknown event type: ${unknown.join(", ")}`), { statusCode: 422 });
  const eventTypes = input.event_types && input.event_types.length ? [...new Set(input.event_types)] : null;
  return db.transaction(async (tx) => {
    const before = await getExportSettings(tx as never, ctx.workspaceId);
    await tx
      .insert(copsExportSettings)
      .values({ workspaceId: ctx.workspaceId, enabled: input.enabled, eventTypes, updatedBy: ctx.userId, reason: input.reason, updatedAt: new Date() })
      .onConflictDoUpdate({ target: copsExportSettings.workspaceId, set: { enabled: input.enabled, eventTypes, updatedBy: ctx.userId, reason: input.reason, updatedAt: new Date() } });
    await writeCopsAudit(tx as never, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "export_settings",
      entityId: ctx.workspaceId,
      action: "export_settings.updated",
      before: { enabled: before.enabled, event_types: before.event_types },
      after: { enabled: input.enabled, event_types: eventTypes },
      reason: input.reason,
      correlationId: ctx.requestId,
      sourceChannel: "web",
    });
    return getExportSettings(tx as never, ctx.workspaceId);
  });
}
