import { randomUUID } from "node:crypto";
import type { Db } from "@skout/db";
import { writeCopsAudit } from "./cops-platform.service.js";

/**
 * Workbook activity (WB2-016, PRD WB-5) is kept in the existing audit log: entity type `workbook`, entity id the
 * workbook, written in the same transaction as the change it describes. An operation that fails records nothing, and
 * a change cannot be saved without its record.
 *
 * Records name things (ids, column names, counts, setting names). They never hold setting values, cell values,
 * addresses, keys or provider internals.
 */
export const WORKBOOK_ENTITY = "workbook";

/**
 * Every audit action the activity feed shows, with the type the API reports it as. The four deletion and restore
 * actions were written before WB2-016 and keep their names.
 */
export const WORKBOOK_ACTIVITY_TYPES = {
  "workbook.rows.added": "rows.added",
  "workbook.rows.delete": "rows.deleted",
  "workbook.column.added": "column.added",
  "workbook.column.updated": "column.updated",
  "workbook.column.hidden": "column.hidden",
  "workbook.column.shown": "column.shown",
  "workbook.column.frozen": "column.frozen",
  "workbook.column.unfrozen": "column.unfrozen",
  "workbook.column.resized": "column.resized",
  "workbook.columns.reordered": "columns.reordered",
  "workbook.column.delete": "column.deleted",
  "workbook.delete": "workbook.deleted",
  "workbook.restore": "workbook.restored",
  "workbook.run.started": "run.started",
  "workbook.run.finished": "run.finished",
  "workbook.export": "export",
  "workbook.crm_push": "crm_push",
} as const;

export type WorkbookAction = keyof typeof WORKBOOK_ACTIVITY_TYPES;

export interface ActivityEntry {
  action: WorkbookAction;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** `worker` for something a background job reports. */
  channel?: "api" | "worker";
}

/** Who did it: taken from the session, or from a server-side job record, never from a request body. */
export interface ActivityActor {
  workspaceId: string;
  /** Null for a caller that is not a user (recorded as an integration). */
  userId: string | null;
  requestId?: string;
}

export async function recordWorkbookActivity(db: Db, actor: ActivityActor, workbookId: string, entry: ActivityEntry): Promise<void> {
  await writeCopsAudit(db, {
    tenantId: actor.workspaceId,
    actor: actor.userId ? { type: "user", id: actor.userId } : { type: "integration", id: null },
    entityType: WORKBOOK_ENTITY,
    entityId: workbookId,
    action: entry.action,
    before: entry.before,
    after: entry.after,
    // An empty x-request-id header must not stop the change being recorded.
    correlationId: actor.requestId || randomUUID(),
    sourceChannel: entry.channel ?? "api",
  });
}
