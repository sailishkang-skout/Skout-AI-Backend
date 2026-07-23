import { and, asc, count, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { createLogger } from "@skout/observability";

const { inboxes, inboxMessages, inboxThreads } = schema;
const log = createLogger("inbox-rotation.service");

export type InboxRow = typeof inboxes.$inferSelect;

function todayUtcMidnight(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Count outbound messages sent from an inbox since UTC midnight. */
async function sentTodayForInbox(db: Db, inboxId: string): Promise<number> {
  const [stat] = await db
    .select({ sentToday: count(inboxMessages.id) })
    .from(inboxMessages)
    .innerJoin(inboxThreads, eq(inboxMessages.threadId, inboxThreads.id))
    .where(
      and(
        eq(inboxThreads.inboxId, inboxId),
        eq(inboxMessages.direction, "outbound"),
        gte(inboxMessages.sentAt, todayUtcMidnight())
      )
    );
  return Number(stat?.sentToday ?? 0);
}

/**
 * Picks the active inbox least-recently used for sending (round-robin via lastUsedAt),
 * skipping any inbox that has already hit its dailySendLimit today.
 */
export async function pickNextInbox(db: Db, workspaceId: string): Promise<InboxRow | null> {
  const candidates = await db
    .select()
    .from(inboxes)
    .where(and(eq(inboxes.workspaceId, workspaceId), eq(inboxes.status, "active")))
    .orderBy(sql`${inboxes.lastUsedAt} asc nulls first`, asc(inboxes.createdAt));

  for (const inbox of candidates) {
    const sentToday = await sentTodayForInbox(db, inbox.id);
    if (sentToday < inbox.dailySendLimit) {
      return inbox;
    }
    log.debug("inbox at daily send cap — skipping", {
      workspaceId,
      inboxId: inbox.id,
      sentToday,
      dailySendLimit: inbox.dailySendLimit,
    });
  }

  if (candidates.length > 0) {
    log.warn("all active inboxes at daily send cap", {
      workspaceId,
      inboxCount: candidates.length,
    });
  }
  return null;
}

export async function markInboxUsed(db: Db, inboxId: string): Promise<void> {
  await db
    .update(inboxes)
    .set({
      lastUsedAt: new Date(),
      updatedAt: new Date(),
      sentCount: sql`${inboxes.sentCount} + 1`,
    })
    .where(eq(inboxes.id, inboxId));
}

async function checkAndAutoPause(db: Db, inboxId: string, config: Env): Promise<void> {
  const [inbox] = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
  if (!inbox) return;

  const { sentCount, bounceCount, spamCount } = inbox;
  if (sentCount === 0 || sentCount < config.INBOX_MIN_SENT_BEFORE_HEALTH_CHECK) return;

  const bounceRate = bounceCount / sentCount;
  const spamRate = spamCount / sentCount;

  if (bounceRate > config.INBOX_BOUNCE_RATE_THRESHOLD || spamRate > config.INBOX_SPAM_RATE_THRESHOLD) {
    await db.update(inboxes).set({ status: "paused", updatedAt: new Date() }).where(eq(inboxes.id, inboxId));
    log.warn("Inbox auto-paused due to high bounce/spam rate", { inboxId, bounceRate, spamRate });
  }
}

export async function recordBounce(db: Db, inboxId: string, config: Env): Promise<void> {
  await db
    .update(inboxes)
    .set({ bounceCount: sql`${inboxes.bounceCount} + 1`, updatedAt: new Date() })
    .where(eq(inboxes.id, inboxId));
  await checkAndAutoPause(db, inboxId, config);
}

export async function recordSpam(db: Db, inboxId: string, config: Env): Promise<void> {
  await db
    .update(inboxes)
    .set({ spamCount: sql`${inboxes.spamCount} + 1`, updatedAt: new Date() })
    .where(eq(inboxes.id, inboxId));
  await checkAndAutoPause(db, inboxId, config);
}
