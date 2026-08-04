import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { sendMail } from "./mail.service.js";

const { notifications, notificationPreferences, users, workspaces } = schema;

const log = createLogger("notifications.service");

/** "in_app" | "email" | "both" — R17.4 per-type channel preference. */
export type NotificationChannel = "in_app" | "email" | "both";

export interface NotificationDto {
  id: string;
  workspaceId: string;
  userId: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  deliveredChannels: string[];
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPreferenceDto {
  id: string;
  workspaceId: string;
  userId: string;
  type: string;
  channel: NotificationChannel;
}

function toDto(row: typeof notifications.$inferSelect): NotificationDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    type: row.type,
    title: row.title,
    body: row.body,
    entityType: row.entityType,
    entityId: row.entityId,
    deliveredChannels: (row.deliveredChannels as string[]) ?? [],
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function prefToDto(row: typeof notificationPreferences.$inferSelect): NotificationPreferenceDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    type: row.type,
    channel: row.channel as NotificationChannel,
  };
}

export async function listNotifications(
  db: Db,
  workspaceId: string,
  userId: string,
  opts: { unreadOnly?: boolean; type?: string; limit?: number } = {}
): Promise<NotificationDto[]> {
  const conditions = [eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId)];
  if (opts.unreadOnly) conditions.push(isNull(notifications.readAt));
  if (opts.type) conditions.push(eq(notifications.type, opts.type));
  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(opts.limit ?? 50);
  return rows.map(toDto);
}

export async function unreadCount(db: Db, workspaceId: string, userId: string): Promise<number> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId), isNull(notifications.readAt))
    );
  return rows.length;
}

export async function markRead(db: Db, workspaceId: string, userId: string, id: string): Promise<boolean> {
  const [row] = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId)))
    .returning();
  return Boolean(row);
}

export async function markAllRead(db: Db, workspaceId: string, userId: string): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId), isNull(notifications.readAt))
    )
    .returning();
  return rows.length;
}

export async function listPreferences(db: Db, workspaceId: string, userId: string): Promise<NotificationPreferenceDto[]> {
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(and(eq(notificationPreferences.workspaceId, workspaceId), eq(notificationPreferences.userId, userId)));
  return rows.map(prefToDto);
}

export async function setPreference(
  db: Db,
  workspaceId: string,
  userId: string,
  type: string,
  channel: NotificationChannel
): Promise<NotificationPreferenceDto> {
  const [existing] = await db
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.workspaceId, workspaceId),
        eq(notificationPreferences.userId, userId),
        eq(notificationPreferences.type, type)
      )
    )
    .limit(1);

  if (existing) {
    const [row] = await db
      .update(notificationPreferences)
      .set({ channel, updatedAt: new Date() })
      .where(eq(notificationPreferences.id, existing.id))
      .returning();
    return prefToDto(row);
  }

  const [row] = await db
    .insert(notificationPreferences)
    .values({ workspaceId, userId, type, channel })
    .returning();
  return prefToDto(row);
}

async function resolveChannel(db: Db, workspaceId: string, userId: string, type: string): Promise<NotificationChannel> {
  const [specific] = await db
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.workspaceId, workspaceId),
        eq(notificationPreferences.userId, userId),
        eq(notificationPreferences.type, type)
      )
    )
    .limit(1);
  if (specific) return specific.channel as NotificationChannel;

  const [fallback] = await db
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.workspaceId, workspaceId),
        eq(notificationPreferences.userId, userId),
        eq(notificationPreferences.type, "*")
      )
    )
    .limit(1);
  if (fallback) return fallback.channel as NotificationChannel;

  // Safe default: in-app only. Never opt someone into email/Slack without an explicit preference row.
  return "in_app";
}

async function deliverSlack(config: Env, db: Db, workspaceId: string, title: string, body: string | null): Promise<boolean> {
  const [ws] = await db.select({ slackWebhookUrl: workspaces.slackWebhookUrl }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws?.slackWebhookUrl) return false;
  try {
    const res = await fetch(ws.slackWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body ? `*${title}*\n${body}` : title }),
    });
    return res.ok;
  } catch (err) {
    log.warn("Slack notification delivery failed", { err, workspaceId });
    return false;
  }
}

export interface CreateNotificationInput {
  workspaceId: string;
  userId: string;
  type: string;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
}

/**
 * R17.1 create + R17.4 deliver. Delivery failures (email/Slack) never block in-app creation —
 * the notification row is always inserted first; delivery is best-effort after.
 */
export async function createNotification(db: Db, config: Env, input: CreateNotificationInput): Promise<NotificationDto> {
  const [row] = await db
    .insert(notifications)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      entityType: input.entityType,
      entityId: input.entityId,
      deliveredChannels: ["in_app"],
    })
    .returning();

  const delivered = new Set<string>(["in_app"]);
  const channel = await resolveChannel(db, input.workspaceId, input.userId, input.type);

  if (channel === "email" || channel === "both") {
    try {
      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, input.userId)).limit(1);
      if (user?.email) {
        const mail = await sendMail(config, {
          to: user.email,
          subject: input.title,
          text: input.body ?? input.title,
          html: `<p><strong>${input.title}</strong></p>${input.body ? `<p>${input.body}</p>` : ""}`,
        });
        if (mail.sent) delivered.add("email");
      }
    } catch (err) {
      log.warn("Email notification delivery failed", { err, userId: input.userId });
    }
  }

  // Slack is workspace-level (single webhook), so it fires for "both"/"email" workspace-critical
  // alerts too when connected — gated purely on the workspace having a webhook configured.
  const slackOk = await deliverSlack(config, db, input.workspaceId, input.title, input.body ?? null);
  if (slackOk) delivered.add("slack");

  if (delivered.size > 1) {
    await db
      .update(notifications)
      .set({ deliveredChannels: Array.from(delivered) })
      .where(eq(notifications.id, row.id));
  }

  return toDto({ ...row, deliveredChannels: Array.from(delivered) });
}
