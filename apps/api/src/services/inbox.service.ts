import { and, asc, count, desc, eq, gt, gte, sql } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { encryptSecret, decryptSecret } from "../utils/integration-crypto.js";
import { HttpError } from "../utils/http.js";
import nodemailer from "nodemailer";
import { randomBytes } from "node:crypto";

const { inboxes, inboxThreads, inboxMessages, sendingDomains, prospectActivations, prospectScores, sequences, sequenceEnrollments } = schema;

type Db = ReturnType<typeof createDb>["db"];

export type ThreadStatus = "new" | "replied" | "bounced" | "meeting_booked" | "closed";

const ALLOWED_MANUAL_TRANSITIONS: Partial<Record<ThreadStatus, ThreadStatus[]>> = {
  replied: ["meeting_booked", "closed"],
  new: ["closed"],
  meeting_booked: ["closed"],
  bounced: ["closed"],
  closed: [],
};

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

// ---------------------------------------------------------------------------
// Standalone functions (used by inbox CRUD + rotation routes)
// ---------------------------------------------------------------------------

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

export async function updateInbox(
  db: Db,
  workspaceId: string,
  id: string,
  patch: { displayName?: string; dailySendLimit?: number; status?: string }
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

export async function listDomains(db: Db, workspaceId: string) {
  const data = await db
    .select()
    .from(sendingDomains)
    .where(eq(sendingDomains.workspaceId, workspaceId))
    .orderBy(sendingDomains.createdAt);
  return { workspaceId, data, total: data.length };
}

// ---------------------------------------------------------------------------
// Class-based InboxService (thread management, inbound ingestion, replies)
// ---------------------------------------------------------------------------

type RawInboxRow = typeof inboxes.$inferSelect;

function toPublicInbox(row: RawInboxRow) {
  const { smtpPasswordEncrypted, ...rest } = row;
  return { ...rest, smtpConfigured: smtpPasswordEncrypted != null && smtpPasswordEncrypted.length > 0 };
}

export interface CreateInboxInput {
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
  imapHost?: string;
  imapPort?: number;
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

  async createInbox(workspaceId: string, input: CreateInboxInput) {
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
        displayName: input.displayName ?? null,
        provider: input.provider ?? "smtp",
        dailySendLimit: input.dailySendLimit ?? 50,
        sendingDomainId: input.sendingDomainId ?? null,
        smtpHost: input.smtpHost ?? null,
        smtpPort: input.smtpPort ?? null,
        smtpUsername: input.smtpUsername ?? null,
        smtpPasswordEncrypted,
        smtpSecure: input.smtpSecure ?? true,
        imapHost: input.imapHost ?? null,
        imapPort: input.imapPort ?? null,
      })
      .returning();
    return row ? toPublicInbox(row) : null;
  }

  async listThreads(
    workspaceId: string,
    options: { status?: ThreadStatus; unreadOnly?: boolean; limit?: number; offset?: number } = {}
  ) {
    const conditions = [eq(inboxThreads.workspaceId, workspaceId)];

    if (options.status) {
      conditions.push(eq(inboxThreads.status, options.status));
    }
    if (options.unreadOnly) {
      conditions.push(gt(inboxThreads.unreadCount, 0));
    }

    const limit = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;
    const where = and(...conditions);

    const [{ total }] = await this.db.select({ total: count() }).from(inboxThreads).where(where);

    const rows = await this.db
      .select()
      .from(inboxThreads)
      .where(where)
      .orderBy(desc(inboxThreads.updatedAt))
      .limit(limit)
      .offset(offset);

    return { workspaceId, data: rows, total, limit, offset };
  }

  async getThread(workspaceId: string, threadId: string) {
    const [thread] = await this.db
      .select()
      .from(inboxThreads)
      .where(and(eq(inboxThreads.workspaceId, workspaceId), eq(inboxThreads.id, threadId)))
      .limit(1);
    if (!thread) throw new HttpError("thread_not_found", 404);
    return thread;
  }

  async getThreadContext(workspaceId: string, threadId: string) {
    const thread = await this.getThread(workspaceId, threadId);

    let prospect = null;
    if (thread.prospectId) {
      const [activation] = await this.db
        .select({ snapshot: prospectActivations.snapshot })
        .from(prospectActivations)
        .where(
          and(
            eq(prospectActivations.workspaceId, workspaceId),
            eq(prospectActivations.prospectId, thread.prospectId)
          )
        )
        .limit(1);

      const [score] = await this.db
        .select({
          score: prospectScores.score,
          priority: prospectScores.priority,
          reasoning: prospectScores.reasoning,
          scoredAt: prospectScores.scoredAt,
        })
        .from(prospectScores)
        .where(
          and(
            eq(prospectScores.workspaceId, workspaceId),
            eq(prospectScores.prospectId, thread.prospectId)
          )
        )
        .limit(1);

      const snap = (activation?.snapshot ?? {}) as Record<string, unknown>;
      prospect = {
        prospectId: thread.prospectId,
        fullName: snap.fullName as string | undefined,
        title: snap.title as string | undefined,
        companyDomain: snap.companyDomain as string | undefined,
        companyName: snap.companyName as string | undefined,
        email: snap.email as string | undefined,
        industry: snap.industry as string | undefined,
        country: snap.country as string | undefined,
        employeeCount: snap.employeeCount as number | undefined,
        linkedinUrl: snap.linkedinUrl as string | undefined,
        icpScore: score?.score ?? null,
        icpBand: score?.priority ?? null,
        icpReasoning: score?.reasoning ?? null,
        scoredAt: score?.scoredAt ?? null,
      };
    }

    let sequence = null;
    if (thread.enrollmentId) {
      const [row] = await this.db
        .select({
          enrollmentId: sequenceEnrollments.id,
          enrollmentStatus: sequenceEnrollments.status,
          enrolledAt: sequenceEnrollments.enrolledAt,
          completedAt: sequenceEnrollments.completedAt,
          sequenceId: sequences.id,
          sequenceName: sequences.name,
          sequenceStatus: sequences.status,
        })
        .from(sequenceEnrollments)
        .innerJoin(sequences, eq(sequences.id, sequenceEnrollments.sequenceId))
        .where(eq(sequenceEnrollments.id, thread.enrollmentId))
        .limit(1);

      if (row) sequence = row;
    }

    return { threadId, prospect, sequence };
  }

  async listMessages(
    workspaceId: string,
    threadId: string,
    options: { limit?: number; offset?: number } = {}
  ) {
    await this.getThread(workspaceId, threadId);
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;
    const rows = await this.db
      .select()
      .from(inboxMessages)
      .where(eq(inboxMessages.threadId, threadId))
      .orderBy(asc(inboxMessages.sentAt))
      .limit(limit)
      .offset(offset);
    return { threadId, data: rows, total: rows.length };
  }

  async markThreadRead(workspaceId: string, threadId: string) {
    await this.getThread(workspaceId, threadId);
    await this.db
      .update(inboxThreads)
      .set({ unreadCount: 0, updatedAt: new Date() })
      .where(and(eq(inboxThreads.workspaceId, workspaceId), eq(inboxThreads.id, threadId)));
    return { ok: true };
  }

  async transitionThreadStatus(workspaceId: string, threadId: string, targetStatus: ThreadStatus) {
    const thread = await this.getThread(workspaceId, threadId);
    const current = thread.status as ThreadStatus;
    const allowed = ALLOWED_MANUAL_TRANSITIONS[current] ?? [];
    if (!allowed.includes(targetStatus)) {
      throw new HttpError(`Cannot transition thread from '${current}' to '${targetStatus}'`, 422);
    }
    const now = new Date();
    const [updated] = await this.db
      .update(inboxThreads)
      .set({ status: targetStatus, statusChangedAt: now, updatedAt: now })
      .where(and(eq(inboxThreads.workspaceId, workspaceId), eq(inboxThreads.id, threadId)))
      .returning();
    return updated!;
  }

  async replyToThread(workspaceId: string, threadId: string, body: { text: string; html?: string }) {
    const thread = await this.getThread(workspaceId, threadId);
    const [inbox] = await this.db
      .select()
      .from(inboxes)
      .where(and(eq(inboxes.workspaceId, workspaceId), eq(inboxes.id, thread.inboxId)))
      .limit(1);

    if (!inbox) throw new HttpError("inbox_not_found", 404);
    if (!inbox.smtpHost || !inbox.smtpPort || !inbox.smtpUsername || !inbox.smtpPasswordEncrypted) {
      throw new HttpError("inbox_smtp_not_configured", 422);
    }

    const encKey = this.config.INTEGRATION_ENCRYPTION_KEY;
    if (!encKey) throw new HttpError("INTEGRATION_ENCRYPTION_KEY not configured", 503);

    const [lastMsg] = await this.db
      .select({ messageId: inboxMessages.messageId, referencesHeader: inboxMessages.referencesHeader, fromAddress: inboxMessages.fromAddress })
      .from(inboxMessages)
      .where(eq(inboxMessages.threadId, threadId))
      .orderBy(desc(inboxMessages.sentAt))
      .limit(1);

    const replyTo =
      lastMsg?.fromAddress && lastMsg.fromAddress !== inbox.emailAddress
        ? lastMsg.fromAddress
        : (thread.prospectId ?? "unknown@unknown.com");

    const inReplyTo = lastMsg?.messageId ?? undefined;
    const refs = [lastMsg?.referencesHeader, lastMsg?.messageId].filter(Boolean).join(" ").trim() || undefined;

    const domain = inbox.emailAddress.split("@")[1] ?? "skout.ai";
    const newMessageId = `<${randomBytes(16).toString("hex")}@${domain}>`;

    const password = decryptSecret(inbox.smtpPasswordEncrypted, encKey);
    const transporter = nodemailer.createTransport({
      host: inbox.smtpHost,
      port: inbox.smtpPort,
      secure: inbox.smtpSecure,
      auth: { user: inbox.smtpUsername, pass: password },
    });

    const subject = thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`;
    const fromField = inbox.displayName ? `"${inbox.displayName}" <${inbox.emailAddress}>` : inbox.emailAddress;

    await transporter.sendMail({
      from: fromField, to: replyTo, subject,
      text: body.text, html: body.html ?? body.text,
      messageId: newMessageId,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(refs ? { references: refs } : {}),
    });

    const now = new Date();
    const [inserted] = await this.db
      .insert(inboxMessages)
      .values({
        threadId, direction: "outbound",
        fromAddress: inbox.emailAddress, toAddress: replyTo,
        subject, bodyText: body.text, bodyHtml: body.html ?? null,
        messageId: newMessageId, inReplyTo: inReplyTo ?? null, referencesHeader: refs ?? null,
        sentAt: now,
      })
      .returning();

    await this.db
      .update(inboxThreads)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(and(eq(inboxThreads.workspaceId, workspaceId), eq(inboxThreads.id, threadId)));

    return inserted!;
  }

  async getUnreadCounts(workspaceId: string) {
    const rows = await this.db
      .select({ status: inboxThreads.status, threads: count() })
      .from(inboxThreads)
      .where(eq(inboxThreads.workspaceId, workspaceId))
      .groupBy(inboxThreads.status);
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.threads]));
    const total = rows.reduce((acc, r) => acc + r.threads, 0);
    return { workspaceId, total, byStatus };
  }
}

export function buildInboxService(db: Db | null, config: Env): InboxService | null {
  if (!db) return null;
  return new InboxService(db, config);
}
