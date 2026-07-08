import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { createLogger } from "@skout/observability";

const { inboxes } = schema;
const log = createLogger("inbox-rotation.service");

export type InboxRow = typeof inboxes.$inferSelect;

/** Picks the active inbox least-recently used for sending (round-robin via lastUsedAt). */
export async function pickNextInbox(db: Db, workspaceId: string): Promise<InboxRow | null> {
  const [inbox] = await db
    .select()
    .from(inboxes)
    .where(and(eq(inboxes.workspaceId, workspaceId), eq(inboxes.status, "active")))
    .orderBy(sql`${inboxes.lastUsedAt} asc nulls first`, asc(inboxes.createdAt))
    .limit(1);
  return inbox ?? null;
}

export async function markInboxUsed(db: Db, inboxId: string): Promise<void> {
  await db.update(inboxes).set({ lastUsedAt: new Date(), updatedAt: new Date() }).where(eq(inboxes.id, inboxId));
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
