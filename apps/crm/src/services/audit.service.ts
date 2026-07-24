import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";

const { auditLogs } = schema;

type AuditDb = Pick<Db, "select" | "insert" | "update" | "delete">;

export type AuditAction = "create" | "update" | "delete";

export interface AuditLogDto {
  id: string;
  workspaceId: string;
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  beforeState: unknown | null;
  afterState: unknown | null;
  createdAt: string;
}

function toAuditState<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])
  );
}

function toDto(row: typeof auditLogs.$inferSelect): AuditLogDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actorId: row.actorId,
    action: row.action as AuditAction,
    entityType: row.entityType,
    entityId: row.entityId,
    beforeState: row.beforeState ?? null,
    afterState: row.afterState ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class AuditService {
  constructor(private readonly db: AuditDb) {}

  async list(
    workspaceId: string,
    entityType: string,
    entityId: string,
    options: { limit: number; offset: number }
  ): Promise<{ data: AuditLogDto[]; total: number }> {
    const conditions = [eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.entityType, entityType), eq(auditLogs.entityId, entityId)];

    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(asc(auditLogs.createdAt))
      .limit(options.limit)
      .offset(options.offset);

    const all = await this.db.select({ id: auditLogs.id }).from(auditLogs).where(and(...conditions));

    return { data: rows.map(toDto), total: all.length };
  }

  async record(
    workspaceId: string,
    actorId: string | undefined,
    action: AuditAction,
    entityType: string,
    entityId: string,
    beforeState: unknown | null,
    afterState: unknown | null
  ): Promise<AuditLogDto> {
    const [row] = await this.db
      .insert(auditLogs)
      .values({
        workspaceId,
        actorId: actorId ?? null,
        action,
        entityType,
        entityId,
        beforeState: beforeState ? toAuditState(beforeState as Record<string, unknown>) : null,
        afterState: afterState ? toAuditState(afterState as Record<string, unknown>) : null,
      })
      .returning();

    return toDto(row);
  }
}

export function buildAuditService(db: AuditDb | null): AuditService | null {
  return db ? new AuditService(db) : null;
}
