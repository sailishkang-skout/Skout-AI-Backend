import { and, count, eq, gte, sql } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { encryptSecret } from "../utils/integration-crypto.js";
import { HttpError } from "../utils/http.js";

const { inboxes, inboxThreads, inboxMessages, sendingDomains } = schema;

type Db = ReturnType<typeof createDb>["db"];

function todayUtcMidnight(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function withDailyStats(db: Db, rows: (typeof inboxes.$inferSelect)[]) {
  return Promise.all(
    rows.map(async (inbox) => {
      const [stat] = await db
        .select({ sentToday: count(inboxMessages.id) })
        .from(inboxMessages)
        .innerJoin(inboxThreads, eq(inboxMessages.threadId, inboxThreads.id))
        .where(
          and(
            eq(inboxThreads.inboxId, inbox.id),
            eq(inboxMessages.direction, "outbound"),
            gte(inboxMessages.sentAt, todayUtcMidnight())
          )
        );
      return { ...inbox, sentToday: stat?.sentToday ?? 0 };
    })
  );
}

export async function listInboxes(db: Db, workspaceId: string) {
  const rows = await db
    .select()
    .from(inboxes)
    .where(eq(inboxes.workspaceId, workspaceId))
    .orderBy(inboxes.createdAt);
  const data = await withDailyStats(db, rows);
  return { workspaceId, data, total: data.length };
}

export async function getInboxById(db: Db, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(inboxes)
    .where(and(eq(inboxes.workspaceId, workspaceId), eq(inboxes.id, id)))
    .limit(1);
  if (!row) return null;
  const [withStats] = await withDailyStats(db, [row]);
  return withStats ?? null;
}

const createInboxSchema = {
  parse(data: unknown) {
    const d = data as Record<string, unknown>;
    return {
      emailAddress: String(d.emailAddress ?? ""),
      displayName: d.displayName != null ? String(d.displayName) : undefined,
      provider: d.provider != null ? String(d.provider) : "smtp",
      dailySendLimit:
        d.dailySendLimit != null ? Number(d.dailySendLimit) : 50,
      sendingDomainId: d.sendingDomainId != null ? String(d.sendingDomainId) : undefined,
    };
  },
};

export async function createInbox(
  db: Db,
  workspaceId: string,
  data: {
    emailAddress: string;
    displayName?: string;
    provider?: string;
    dailySendLimit?: number;
    sendingDomainId?: string;
  }
) {
  const [row] = await db
    .insert(inboxes)
    .values({
      workspaceId,
      emailAddress: data.emailAddress,
      displayName: data.displayName,
      provider: data.provider ?? "smtp",
      dailySendLimit: data.dailySendLimit ?? 50,
      sendingDomainId: data.sendingDomainId ?? null,
    })
    .returning();
  return row;
}

export async function updateInbox(
  db: Db,
  workspaceId: string,
  id: string,
  patch: {
    displayName?: string;
    dailySendLimit?: number;
    status?: string;
  }
) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.dailySendLimit !== undefined) set.dailySendLimit = patch.dailySendLimit;
  if (patch.status !== undefined) set.status = patch.status;

  const [row] = await db
    .update(inboxes)
    .set(set)
    .where(and(eq(inboxes.workspaceId, workspaceId), eq(inboxes.id, id)))
    .returning();
  return row ?? null;
}

export async function pauseInbox(db: Db, workspaceId: string, id: string) {
  const [row] = await db
    .update(inboxes)
    .set({ status: "paused", updatedAt: new Date() })
    .where(and(eq(inboxes.workspaceId, workspaceId), eq(inboxes.id, id)))
    .returning();
  return row ?? null;
}

export async function resumeInbox(
  db: Db,
  workspaceId: string,
  id: string,
  resetCounters = false
) {
  const set: Record<string, unknown> = { status: "active", updatedAt: new Date() };
  if (resetCounters) {
    set.bounceCount = 0;
    set.spamCount = 0;
    set.sentCount = 0;
  }
  const [row] = await db
    .update(inboxes)
    .set(set)
    .where(and(eq(inboxes.workspaceId, workspaceId), eq(inboxes.id, id)))
    .returning();
  return row ?? null;
}

export async function deleteInbox(db: Db, workspaceId: string, id: string): Promise<boolean> {
  const result = await db
    .delete(inboxes)
    .where(and(eq(inboxes.workspaceId, workspaceId), eq(inboxes.id, id)))
    .returning({ id: inboxes.id });
  return result.length > 0;
}

export async function listThreads(db: Db, workspaceId: string) {
  const data = await db
    .select()
    .from(inboxThreads)
    .where(eq(inboxThreads.workspaceId, workspaceId))
    .orderBy(sql`${inboxThreads.lastMessageAt} DESC NULLS LAST`);
  return { workspaceId, data, total: data.length };
}

export async function listDomains(db: Db, workspaceId: string) {
  const data = await db
    .select()
    .from(sendingDomains)
    .where(eq(sendingDomains.workspaceId, workspaceId))
    .orderBy(sendingDomains.createdAt);
  return { workspaceId, data, total: data.length };
}

// ---------------------------------------------------------------------------
// Class-based API (used by inbox.service.test.ts and injectable contexts)
// ---------------------------------------------------------------------------

type RawInboxRow = typeof inboxes.$inferSelect;

function toPublicInbox(row: RawInboxRow) {
  const { smtpPasswordEncrypted, ...rest } = row;
  return { ...rest, smtpConfigured: smtpPasswordEncrypted != null && smtpPasswordEncrypted.length > 0 };
}

export class InboxService {
  constructor(
    private readonly db: Db,
    private readonly config: Env
  ) {}

  async listInboxes(workspaceId: string) {
    const rows = await this.db
      .select()
      .from(inboxes)
      .where(eq(inboxes.workspaceId, workspaceId))
      .orderBy(inboxes.createdAt);
    const data = rows.map(toPublicInbox);
    return { workspaceId, data, total: data.length };
  }

  async createInbox(
    workspaceId: string,
    input: {
      emailAddress: string;
      displayName?: string;
      provider?: string;
      dailySendLimit?: number;
      sendingDomainId?: string;
      smtpHost?: string;
      smtpPort?: number;
      smtpUsername?: string;
      smtpPassword?: string;
      smtpSecure?: boolean;
    }
  ) {
    const encryptionKey = this.config.INTEGRATION_ENCRYPTION_KEY;
    let smtpPasswordEncrypted: string | null = null;

    if (input.smtpPassword) {
      if (!encryptionKey) throw new HttpError("INTEGRATION_ENCRYPTION_KEY not configured", 503);
      smtpPasswordEncrypted = encryptSecret(input.smtpPassword, encryptionKey);
    }

    const [row] = await this.db
      .insert(inboxes)
      .values({
        workspaceId,
        emailAddress: input.emailAddress,
        displayName: input.displayName,
        provider: input.provider ?? "smtp",
        dailySendLimit: input.dailySendLimit ?? 50,
        sendingDomainId: input.sendingDomainId ?? null,
        smtpHost: input.smtpHost ?? null,
        smtpPort: input.smtpPort ?? null,
        smtpUsername: input.smtpUsername ?? null,
        smtpPasswordEncrypted,
      })
      .returning();

    return row ? toPublicInbox(row) : null;
  }

  async listThreads(workspaceId: string) {
    const data = await this.db
      .select()
      .from(inboxThreads)
      .where(eq(inboxThreads.workspaceId, workspaceId))
      .orderBy(sql`${inboxThreads.lastMessageAt} DESC NULLS LAST`);
    return { workspaceId, data, total: data.length };
  }
}

export function buildInboxService(db: Db | null, config: Env): InboxService | null {
  if (!db) return null;
  return new InboxService(db, config);
}
