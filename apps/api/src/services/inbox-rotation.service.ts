import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";

const { inboxes } = schema;

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
