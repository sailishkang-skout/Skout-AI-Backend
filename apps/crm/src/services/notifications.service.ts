import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";

const { notifications } = schema;

export interface CreateNotificationInput {
  workspaceId: string;
  userId?: string | null;
  type: string;
  entityType: string;
  entityId: string;
  title: string;
  body?: string | null;
}

/**
 * Mirrors apps/api's notification.service.ts (R17.1) — duplicated rather than shared because
 * apps/crm and apps/api are independently deployed services that only share @skout/db's schema,
 * not each other's business logic (matching this monorepo's existing per-app service convention).
 */
export async function createNotification(db: Db, input: CreateNotificationInput): Promise<void> {
  await db.insert(notifications).values({
    workspaceId: input.workspaceId,
    userId: input.userId ?? null,
    type: input.type,
    entityType: input.entityType,
    entityId: input.entityId,
    title: input.title,
    body: input.body ?? null,
  });
}

/** Auto-resolve (R21.3 AC2) — marks any still-unread reminder for an entity as read/cancelled. */
export async function resolveNotificationsForEntity(
  db: Db,
  entityType: string,
  entityId: string
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.entityType, entityType),
        eq(notifications.entityId, entityId),
        isNull(notifications.readAt)
      )
    );
}
