import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { ActivityCreateInput, ActivityType, CrmEntityType } from "@skout/shared";

const { activities } = schema;

export interface ActivityDto {
  id: string;
  workspaceId: string;
  entityType: string;
  entityId: string;
  activityType: string;
  subject: string | null;
  body: string | null;
  ownerId: string | null;
  occurredAt: string;
  createdAt: string;
}

function toDto(row: typeof activities.$inferSelect): ActivityDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    entityType: row.entityType,
    entityId: row.entityId,
    activityType: row.activityType,
    subject: row.subject,
    body: row.body,
    ownerId: row.ownerId,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export class ActivitiesService {
  constructor(private readonly db: Db) {}

  async list(
    workspaceId: string,
    entityType: string,
    entityId: string,
    options: { limit: number; offset: number }
  ): Promise<{ data: ActivityDto[]; total: number }> {
    const conditions = [
      eq(activities.workspaceId, workspaceId),
      eq(activities.entityType, entityType),
      eq(activities.entityId, entityId),
    ];

    const rows = await this.db
      .select()
      .from(activities)
      .where(and(...conditions))
      .orderBy(desc(activities.occurredAt))
      .limit(options.limit)
      .offset(options.offset);

    const all = await this.db
      .select({ id: activities.id })
      .from(activities)
      .where(and(...conditions));

    return { data: rows.map(toDto), total: all.length };
  }

  /** Workspace-wide recent activity feed (not filtered by entity) — used by the dashboard overview. */
  async recent(workspaceId: string, limit: number): Promise<ActivityDto[]> {
    const rows = await this.db
      .select()
      .from(activities)
      .where(eq(activities.workspaceId, workspaceId))
      .orderBy(desc(activities.occurredAt))
      .limit(limit);
    return rows.map(toDto);
  }

  async create(workspaceId: string, ownerId: string | undefined, input: ActivityCreateInput): Promise<ActivityDto> {
    return this.record(workspaceId, ownerId, input.entityType, input.entityId, input.activityType, input.subject, input.body);
  }

  async record(
    workspaceId: string,
    ownerId: string | undefined,
    entityType: CrmEntityType,
    entityId: string,
    activityType: ActivityType,
    subject?: string,
    body?: string
  ): Promise<ActivityDto> {
    const [row] = await this.db
      .insert(activities)
      .values({ workspaceId, entityType, entityId, activityType, subject, body, ownerId })
      .returning();
    return toDto(row);
  }
}

export function buildActivitiesService(db: Db | null): ActivitiesService | null {
  return db ? new ActivitiesService(db) : null;
}
