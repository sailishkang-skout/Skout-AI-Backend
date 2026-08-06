import { and, count, desc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";

const { notifications } = schema;

export interface NotificationRecord {
  id: string;
  workspaceId: string;
  userId: string | null;
  type: string;
  entityType: string;
  entityId: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
}

function serialize(row: typeof notifications.$inferSelect): NotificationRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    type: row.type,
    entityType: row.entityType,
    entityId: row.entityId,
    title: row.title,
    body: row.body,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CreateNotificationInput {
  workspaceId: string;
  userId?: string | null;
  type: string;
  entityType: string;
  entityId: string;
  title: string;
  body?: string | null;
}

export async function createNotification(db: Db, input: CreateNotificationInput): Promise<NotificationRecord> {
  const [row] = await db
    .insert(notifications)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      title: input.title,
      body: input.body ?? null,
    })
    .returning();
  return serialize(row);
}

export interface ListNotificationsOptions {
  unreadOnly?: boolean;
  type?: string;
  limit?: number;
}

/** Scoped to notifications addressed to this user, plus workspace-wide broadcasts (userId IS NULL). */
export async function listNotifications(
  db: Db,
  workspaceId: string,
  userId: string,
  opts: ListNotificationsOptions = {}
): Promise<NotificationRecord[]> {
  const conditions = [
    eq(notifications.workspaceId, workspaceId),
    or(eq(notifications.userId, userId), isNull(notifications.userId))!,
  ];
  if (opts.unreadOnly) conditions.push(isNull(notifications.readAt));
  if (opts.type) conditions.push(eq(notifications.type, opts.type));

  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(opts.limit ?? 50);

  return rows.map(serialize);
}

export async function getUnreadCount(db: Db, workspaceId: string, userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        or(eq(notifications.userId, userId), isNull(notifications.userId))!,
        isNull(notifications.readAt)
      )
    );
  return row?.value ?? 0;
}

export async function markRead(
  db: Db,
  workspaceId: string,
  userId: string,
  notificationId: string
): Promise<NotificationRecord | null> {
  const [row] = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.workspaceId, workspaceId),
        or(eq(notifications.userId, userId), isNull(notifications.userId))!,
        isNull(notifications.readAt)
      )
    )
    .returning();
  return row ? serialize(row) : null;
}

export async function markAllRead(db: Db, workspaceId: string, userId: string): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        or(eq(notifications.userId, userId), isNull(notifications.userId))!,
        isNull(notifications.readAt)
      )
    )
    .returning({ id: notifications.id });
  return rows.length;
}

/** Auto-resolve (AC2) — marks any still-unread notification for an entity as read. */
export async function resolveNotificationsForEntity(
  db: Db,
  entityType: string,
  entityId: string
): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.entityType, entityType),
        eq(notifications.entityId, entityId),
        isNull(notifications.readAt)
      )
    )
    .returning({ id: notifications.id });
  return rows.length;
}
