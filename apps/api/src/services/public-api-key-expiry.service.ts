import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { createLogger } from "@skout/observability";
import { ctaButton, escapeHtml, renderTransactionalLayout, type MailOptions } from "./mail.service.js";
import type { WebhookEventType } from "./webhook.service.js";
import { maskKey } from "./public-api-keys.service.js";

const log = createLogger("public-api-key-expiry");
const { apiKeys, workspaceMembers, users, auditLogs } = schema;

const DAY_MS = 86_400_000;

/** Reminder milestones (KEY-8): 14 and 3 days before expiry, then the expiry itself. */
export type ExpiryMilestone = "d14" | "d3" | "expired";

export interface KeyExpiryDeps {
  sendMail(opts: MailOptions): Promise<unknown>;
  dispatchWebhook(eventType: WebhookEventType, workspaceId: string, payload: Record<string, unknown>): Promise<void>;
  /** App origin for the "manage keys" link, e.g. https://www.skoutai.io/app. */
  appUrl: string | undefined;
}

export interface KeyExpiryRunResult {
  reminders: { keyId: string; milestone: ExpiryMilestone; recipients: number }[];
}

/** The milestone due for a key at `now`, or null. A late run still sends the nearest one, once. */
export function dueMilestone(expiresAt: Date, sent: Record<string, string>, now: Date): ExpiryMilestone | null {
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) return sent.expired ? null : "expired";
  if (left <= 3 * DAY_MS) return sent.d3 ? null : "d3";
  if (left <= 14 * DAY_MS) return sent.d14 ? null : "d14";
  return null;
}

/**
 * Daily job (PAPI-022, KEY-8): emails the key's creator and every workspace Owner 14 and 3 days
 * before a key expires and sends `api_key.expiring`; on expiry sends `api_key.expired` and writes an
 * audit event (KEY-12). Each milestone is claimed in `expiry_reminders_sent` before anything is sent,
 * so runs on several instances, or a re-run the same day, never repeat a reminder.
 * Revoked keys and keys already replaced by a rotation are skipped.
 */
export async function runKeyExpiryReminders(db: Db, deps: KeyExpiryDeps, now: Date = new Date()): Promise<KeyExpiryRunResult> {
  const candidates = await db
    .select()
    .from(apiKeys)
    .where(and(isNull(apiKeys.revokedAt), isNull(apiKeys.replacedBy), lte(apiKeys.expiresAt, new Date(now.getTime() + 14 * DAY_MS))));

  const result: KeyExpiryRunResult = { reminders: [] };
  for (const key of candidates) {
    const milestone = dueMilestone(key.expiresAt, key.expiryRemindersSent ?? {}, now);
    if (!milestone) continue;
    // A key first seen inside 3 days (or already expired) also counts the earlier milestones as done.
    const marks: Record<string, string> = { [milestone]: now.toISOString() };
    if (milestone !== "d14" && !key.expiryRemindersSent?.d14) marks.d14 = now.toISOString();
    if (milestone === "expired" && !key.expiryRemindersSent?.d3) marks.d3 = now.toISOString();

    const [claimed] = await db
      .update(apiKeys)
      .set({ expiryRemindersSent: sql`${apiKeys.expiryRemindersSent} || ${JSON.stringify(marks)}::jsonb` })
      .where(and(eq(apiKeys.id, key.id), sql`not (${apiKeys.expiryRemindersSent} ? ${milestone})`))
      .returning({ id: apiKeys.id });
    if (!claimed) continue; // another instance got there first

    try {
      const recipients = milestone === "expired" ? [] : await reminderRecipients(db, key.workspaceId, key.createdBy);
      const payload = {
        key_id: key.id,
        name: key.name,
        type: key.type,
        masked_key: maskKey(key.type, key.prefix),
        expires_at: key.expiresAt.toISOString(),
        ...(milestone === "expired" ? {} : { days_left: Math.max(0, Math.ceil((key.expiresAt.getTime() - now.getTime()) / DAY_MS)) }),
      };
      if (milestone === "expired") {
        await db.insert(auditLogs).values({
          workspaceId: key.workspaceId,
          actorType: "system",
          actorRef: "public-api-key-expiry",
          action: "api_key.expired",
          entityType: "api_key",
          entityId: key.id,
          afterState: { masked_key: payload.masked_key, expires_at: payload.expires_at },
        });
        await deps.dispatchWebhook("api_key.expired", key.workspaceId, payload);
      } else {
        for (const to of recipients) {
          await deps.sendMail(buildKeyExpiryEmail({ to, keyName: key.name, maskedKey: payload.masked_key, expiresAt: key.expiresAt, daysLeft: payload.days_left!, appUrl: deps.appUrl }));
        }
        await deps.dispatchWebhook("api_key.expiring", key.workspaceId, payload);
      }
      result.reminders.push({ keyId: key.id, milestone, recipients: recipients.length });
    } catch (err) {
      log.error("API key expiry reminder failed after it was claimed", err, { keyId: key.id, milestone });
    }
  }
  return result;
}

/** The key's creator (if still a member) plus every Owner, each email once. */
async function reminderRecipients(db: Db, workspaceId: string, createdBy: string | null): Promise<string[]> {
  const rows = await db
    .select({ userId: workspaceMembers.userId, role: workspaceMembers.role, email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  const emails = rows.filter((r) => r.role === "owner" || (createdBy && r.userId === createdBy)).map((r) => r.email.trim().toLowerCase());
  return [...new Set(emails.filter(Boolean))];
}

export function buildKeyExpiryEmail(opts: {
  to: string;
  keyName: string;
  maskedKey: string;
  expiresAt: Date;
  daysLeft: number;
  appUrl: string | undefined;
}): MailOptions {
  const when = opts.expiresAt.toUTCString().replace(/ GMT$/, " UTC");
  const days = opts.daysLeft === 1 ? "1 day" : `${opts.daysLeft} days`;
  const title = `Your Skout API key "${opts.keyName}" expires in ${days}`;
  const link = opts.appUrl ? `${opts.appUrl.replace(/\/$/, "")}/settings/developers` : null;
  const bodyHtml = `
    <p style="margin:0 0 16px;">The API key <strong>${escapeHtml(opts.keyName)}</strong> (<code>${escapeHtml(opts.maskedKey)}</code>) expires on ${escapeHtml(when)}.</p>
    <p style="margin:0 0 16px;">Rotate it before then so your integration keeps working. Rotation gives you a new key and keeps the old one working for a grace period you choose.</p>
    ${link ? `<p style="margin:0 0 8px;">${ctaButton(link, "Manage API keys")}</p>` : ""}
  `;
  return {
    to: opts.to,
    subject: title,
    text: [
      `The API key "${opts.keyName}" (${opts.maskedKey}) expires on ${when}.`,
      "",
      "Rotate it before then so your integration keeps working. Rotation gives you a new key and keeps the old one working for a grace period you choose.",
      ...(link ? ["", `Manage API keys: ${link}`] : []),
    ].join("\n"),
    html: renderTransactionalLayout({
      preheader: title,
      title,
      bodyHtml,
      footerNote: "You're getting this because you created this key or own this Skout AI workspace.",
    }),
  };
}
