import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { sendMail } from "./mail.service.js";
import { isSmsConfigured, sendSms } from "./telecom.service.js";

const { notifications, notificationPreferences, users, workspaces } = schema;

const log = createLogger("notifications.service");

/** "in_app" | "email" | "both" | "sms" — R17.4 per-type channel preference. */
export type NotificationChannel = "in_app" | "email" | "both" | "sms";

export interface NotificationDto {
  id: string;
  workspaceId: string;
  userId: string | null;
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
  digest: boolean;
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
    digest: row.digest,
  };
}

export async function listNotifications(
  db: Db,
  workspaceId: string,
  userId: string,
  opts: { unreadOnly?: boolean; type?: string; limit?: number } = {}
): Promise<NotificationDto[]> {
  const rows = await db
    .select()
    .from(notifications)
    .where(
      scopedTo(
        notifications,
        workspaceId,
        or(eq(notifications.userId, userId), isNull(notifications.userId)),
        opts.unreadOnly ? isNull(notifications.readAt) : undefined,
        opts.type ? eq(notifications.type, opts.type) : undefined
      )
    )
    .orderBy(desc(notifications.createdAt))
    .limit(opts.limit ?? 50);
  return rows.map(toDto);
}

export async function unreadCount(db: Db, workspaceId: string, userId: string): Promise<number> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      scopedTo(notifications, workspaceId, or(eq(notifications.userId, userId), isNull(notifications.userId))!, isNull(notifications.readAt))
    );
  return rows.length;
}

export async function markRead(db: Db, workspaceId: string, userId: string, id: string): Promise<boolean> {
  const [row] = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      scopedTo(notifications, workspaceId, eq(notifications.id, id), or(eq(notifications.userId, userId), isNull(notifications.userId))!)
    )
    .returning();
  return Boolean(row);
}

export async function markAllRead(db: Db, workspaceId: string, userId: string): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      scopedTo(notifications, workspaceId, or(eq(notifications.userId, userId), isNull(notifications.userId))!, isNull(notifications.readAt))
    )
    .returning();
  return rows.length;
}

/** Auto-resolve (R21.3 AC2) — marks any still-unread notification for an entity as read. */
export async function resolveNotificationsForEntity(
  db: Db,
  entityType: string,
  entityId: string
): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.entityType, entityType), eq(notifications.entityId, entityId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}

export async function listPreferences(db: Db, workspaceId: string, userId: string): Promise<NotificationPreferenceDto[]> {
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(scopedTo(notificationPreferences, workspaceId, eq(notificationPreferences.userId, userId)));
  return rows.map(prefToDto);
}

export async function setPreference(
  db: Db,
  workspaceId: string,
  userId: string,
  type: string,
  channel: NotificationChannel,
  digest = false
): Promise<NotificationPreferenceDto> {
  const [existing] = await db
    .select()
    .from(notificationPreferences)
    .where(
      scopedTo(notificationPreferences, workspaceId, eq(notificationPreferences.userId, userId), eq(notificationPreferences.type, type))
    )
    .limit(1);

  if (existing) {
    const [row] = await db
      .update(notificationPreferences)
      .set({ channel, digest, updatedAt: new Date() })
      .where(eq(notificationPreferences.id, existing.id))
      .returning();
    return prefToDto(row);
  }

  const [row] = await db
    .insert(notificationPreferences)
    .values({ workspaceId, userId, type, channel, digest })
    .returning();
  return prefToDto(row);
}

async function resolvePreference(
  db: Db,
  workspaceId: string,
  userId: string,
  type: string
): Promise<{ channel: NotificationChannel; digest: boolean }> {
  const [specific] = await db
    .select()
    .from(notificationPreferences)
    .where(
      scopedTo(notificationPreferences, workspaceId, eq(notificationPreferences.userId, userId), eq(notificationPreferences.type, type))
    )
    .limit(1);
  if (specific) return { channel: specific.channel as NotificationChannel, digest: specific.digest };

  const [fallback] = await db
    .select()
    .from(notificationPreferences)
    .where(
      scopedTo(notificationPreferences, workspaceId, eq(notificationPreferences.userId, userId), eq(notificationPreferences.type, "*"))
    )
    .limit(1);
  if (fallback) return { channel: fallback.channel as NotificationChannel, digest: fallback.digest };

  // Safe default: in-app only. Never opt someone into email/Slack without an explicit preference row.
  return { channel: "in_app", digest: false };
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
  userId?: string | null; // null/undefined = workspace-wide broadcast
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
      userId: input.userId ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
      entityType: input.entityType,
      entityId: input.entityId,
      deliveredChannels: ["in_app"],
    })
    .returning();

  const delivered = new Set<string>(["in_app"]);
  const { channel, digest } = input.userId
    ? await resolvePreference(db, input.workspaceId, input.userId, input.type)
    : { channel: "in_app" as NotificationChannel, digest: false };

  // R17.3 — digest-preferring users get their email folded into the daily digest sweep instead
  // of a real-time send; the in-app row above is still created immediately either way.
  if (input.userId && !digest && (channel === "email" || channel === "both")) {
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

  // SMS — separate opt-in channel (not folded into "both", which is in-app + email only).
  // Delivery failures never block notification creation, same as email above.
  if (input.userId && !digest && channel === "sms" && isSmsConfigured(config)) {
    try {
      const [user] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, input.userId)).limit(1);
      if (user?.phone) {
        const sms = await sendSms(config, {
          to: user.phone,
          body: input.body ? `${input.title}\n${input.body}` : input.title,
        });
        if (sms.messageSid) delivered.add("sms");
      }
    } catch (err) {
      log.warn("SMS notification delivery failed", { err, userId: input.userId });
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
