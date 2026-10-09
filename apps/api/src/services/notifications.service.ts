import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { captureException, createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { sendMail } from "./mail.service.js";
import { isSmsConfigured, sendSms } from "./telecom.service.js";

const { notifications, notificationPreferences, users, workspaces } = schema;

const log = createLogger("notifications.service");
const PROVIDER_DELIVERY_ATTEMPTS = 3;

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

export async function retryNotificationDelivery<T>(
  channel: string,
  context: Record<string, unknown>,
  deliver: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<T | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROVIDER_DELIVERY_ATTEMPTS; attempt++) {
    try {
      return await deliver();
    } catch (err) {
      lastError = err;
      log.warn("Notification provider attempt failed", { channel, attempt, ...context, err });
      if (attempt < PROVIDER_DELIVERY_ATTEMPTS) await sleep(100 * 2 ** (attempt - 1));
    }
  }
  log.error("Notification provider delivery exhausted retries; in-app notification remains available", {
    channel,
    attempts: PROVIDER_DELIVERY_ATTEMPTS,
    ...context,
  });
  if (lastError) captureException(lastError, { module: "notifications.service", channel, ...context });
  return null;
}

function isMailDeliveryConfigured(config: Env): boolean {
  return Boolean(
    config.SMTP_HOST &&
      config.SMTP_USERNAME &&
      config.SMTP_USERNAME !== "replace-me" &&
      config.SMTP_PASSWORD &&
      config.SMTP_PASSWORD !== "replace-me"
  );
}

async function deliverSlack(
  config: Env,
  db: Db,
  workspaceId: string,
  title: string,
  body: string | null,
  context: Record<string, unknown> = {}
): Promise<boolean | "disabled"> {
  const [ws] = await db.select({ slackWebhookUrl: workspaces.slackWebhookUrl }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const webhookUrl = ws?.slackWebhookUrl;
  if (!webhookUrl) return "disabled";
  const delivered = await retryNotificationDelivery("slack", { workspaceId, ...context }, async () => {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body ? `*${title}*\n${body}` : title }),
    });
    if (!res.ok) throw new Error(`Slack webhook returned HTTP ${res.status}`);
    return true;
  });
  return delivered === true;
}

async function deliverTeams(
  db: Db,
  workspaceId: string,
  title: string,
  body: string | null,
  context: Record<string, unknown> = {}
): Promise<boolean | "disabled"> {
  const [ws] = await db
    .select({ teamsWebhookUrl: workspaces.teamsWebhookUrl })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const webhookUrl = ws?.teamsWebhookUrl;
  if (!webhookUrl) return "disabled";

  const delivered = await retryNotificationDelivery("teams", { workspaceId, ...context }, async () => {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body ? `${title}\n${body}` : title }),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`Teams webhook returned HTTP ${res.status}`);
    return true;
  });
  return delivered === true;
}

export interface CreateNotificationInput {
  workspaceId: string;
  userId?: string | null; // null/undefined = workspace-wide broadcast
  type: string;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  sourceEventId?: string;
}

/**
 * R17.1 create + R17.4 deliver. Provider delivery failures never block in-app creation —
 * the notification row is always inserted first; COPS event consumers may request a throw
 * after bounded provider retries so BullMQ can resume undelivered channels.
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
      sourceEventId: input.sourceEventId,
      deliveredChannels: ["in_app"],
    })
    .returning();

  return deliverNotificationChannels(db, config, {
    ...toDto(row),
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
  });
}

/** Deliver non-in-app channels for an already-persisted notification. */
export async function deliverNotificationChannels(
  db: Db,
  config: Env,
  notification: NotificationDto,
  context: Record<string, unknown> = {},
  options: { retryFailedDelivery?: boolean } = {}
): Promise<NotificationDto> {
  const delivered = new Set<string>(notification.deliveredChannels);
  delivered.add("in_app");
  const persistDelivered = async () => {
    await db
      .update(notifications)
      .set({ deliveredChannels: Array.from(delivered) })
      .where(eq(notifications.id, notification.id));
  };
  const { channel, digest } = notification.userId
    ? await resolvePreference(db, notification.workspaceId, notification.userId, notification.type)
    : { channel: "in_app" as NotificationChannel, digest: false };

  // R17.3 — digest-preferring users get their email folded into the daily digest sweep instead
  // of a real-time send; the in-app row above is still created immediately either way.
  if (
    notification.userId &&
    !delivered.has("email") &&
    !digest &&
    isMailDeliveryConfigured(config) &&
    (channel === "email" || channel === "both")
  ) {
    const userId = notification.userId;
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    if (user?.email) {
      const emailDelivered = await retryNotificationDelivery("email", { userId, workspaceId: notification.workspaceId, ...context }, async () => {
        const mail = await sendMail(config, {
          to: user.email,
          subject: notification.title,
          text: notification.body ?? notification.title,
          html: `<p><strong>${notification.title}</strong></p>${notification.body ? `<p>${notification.body}</p>` : ""}`,
        });
        if (!mail.sent) throw new Error("Email provider did not confirm delivery");
        return true;
      });
      if (emailDelivered) {
        delivered.add("email");
        await persistDelivered();
      } else if (options.retryFailedDelivery) {
        throw new Error("Email notification delivery failed after retries");
      }
    }
  }

  // SMS — separate opt-in channel (not folded into "both", which is in-app + email only).
  // Delivery failures never block notification creation, same as email above.
  if (notification.userId && !delivered.has("sms") && !digest && channel === "sms" && isSmsConfigured(config)) {
    const userId = notification.userId;
    const [user] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, userId)).limit(1);
    const phone = user?.phone;
    if (phone) {
      const smsDelivered = await retryNotificationDelivery("sms", { userId, workspaceId: notification.workspaceId, ...context }, async () => {
        const sms = await sendSms(config, {
          to: phone,
          body: notification.body ? `${notification.title}\n${notification.body}` : notification.title,
        });
        if (!sms.messageSid) throw new Error("SMS provider did not confirm delivery");
        return true;
      });
      if (smsDelivered) {
        delivered.add("sms");
        await persistDelivered();
      } else if (options.retryFailedDelivery) {
        throw new Error("SMS notification delivery failed after retries");
      }
    }
  }

  // Slack is workspace-level (single webhook), so it fires for "both"/"email" workspace-critical
  // alerts too when connected — gated purely on the workspace having a webhook configured.
  if (!delivered.has("slack")) {
    const slackOk = await deliverSlack(
      config,
      db,
      notification.workspaceId,
      notification.title,
      notification.body,
      context
    );
    if (slackOk === true) {
      delivered.add("slack");
      await persistDelivered();
    } else if (slackOk === false && options.retryFailedDelivery) {
      throw new Error("Slack notification delivery failed after retries");
    }
  }

  if (!delivered.has("teams")) {
    const teamsOk = await deliverTeams(
      db,
      notification.workspaceId,
      notification.title,
      notification.body,
      context
    );
    if (teamsOk === true) {
      delivered.add("teams");
      await persistDelivered();
    } else if (teamsOk === false && options.retryFailedDelivery) {
      throw new Error("Teams notification delivery failed after retries");
    }
  }

  return { ...notification, deliveredChannels: Array.from(delivered) };
}
