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

function computeHealth(
  inbox: typeof inboxes.$inferSelect,
  bounceThreshold = 0.05,
  spamThreshold = 0.01,
  minSent = 20,
): "healthy" | "degraded" | "error" {
  if (inbox.status === "paused" || inbox.status === "inactive") return "error";
  const isConfigured =
    (inbox.smtpHost && inbox.smtpPasswordEncrypted) ||
    inbox.oauthAccessTokenEncrypted;
  if (!isConfigured) return "error";
  if (inbox.sentCount >= minSent) {
    const bounceRate = inbox.bounceCount / inbox.sentCount;
    const spamRate = inbox.spamCount / inbox.sentCount;
    if (bounceRate >= bounceThreshold || spamRate >= spamThreshold) return "degraded";
  }
  return "healthy";
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
      const sentToday = Number(stat?.sentToday ?? 0);
      const capPct = inbox.dailySendLimit > 0
        ? Math.min(100, Math.round((sentToday / inbox.dailySendLimit) * 100))
        : 0;
      return { ...inbox, sentToday, capPct, health: computeHealth(inbox) };
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

type StoredDnsRecord = {
  type: "TXT" | "CNAME" | "MX";
  name: string;
  value: string;
  purpose: "SPF" | "DKIM" | "DMARC" | "MX";
  status: "pass" | "fail" | "missing" | "unknown";
};

function generateDnsRecords(domain: string): StoredDnsRecord[] {
  return [
    { type: "TXT", name: domain, value: `v=spf1 include:_spf.skout.dev ~all`, purpose: "SPF", status: "unknown" },
    { type: "TXT", name: `skout._domainkey.${domain}`, value: `v=DKIM1; k=rsa; p=PLACEHOLDER_CONTACT_SUPPORT`, purpose: "DKIM", status: "unknown" },
    { type: "TXT", name: `_dmarc.${domain}`, value: `v=DMARC1; p=none; rua=mailto:dmarc@skout.dev`, purpose: "DMARC", status: "unknown" },
    { type: "MX", name: domain, value: `10 mail.skout.dev`, purpose: "MX", status: "unknown" },
  ];
}

function shapeDomain(row: typeof sendingDomains.$inferSelect) {
  const records = (row.dnsRecords as StoredDnsRecord[]) ?? [];
  const byPurpose: Record<string, string> = Object.fromEntries(records.map((r) => [r.purpose, r.status]));
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    domain: row.domain,
    spfStatus: (byPurpose["SPF"] ?? "unknown") as StoredDnsRecord["status"],
    dkimStatus: (byPurpose["DKIM"] ?? "unknown") as StoredDnsRecord["status"],
    dmarcStatus: (byPurpose["DMARC"] ?? "unknown") as StoredDnsRecord["status"],
    mxStatus: (byPurpose["MX"] ?? "unknown") as StoredDnsRecord["status"],
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listDomains(db: Db, workspaceId: string) {
  const rows = await db
    .select()
    .from(sendingDomains)
    .where(eq(sendingDomains.workspaceId, workspaceId))
    .orderBy(sendingDomains.createdAt);
  return { workspaceId, data: rows.map(shapeDomain), total: rows.length };
}

export async function addDomain(db: Db, workspaceId: string, domain: string) {
  const dnsRecords = generateDnsRecords(domain);
  const [row] = await db
    .insert(sendingDomains)
    .values({ workspaceId, domain, dnsRecords })
    .returning();
  if (!row) throw new Error("Failed to create domain");
  return shapeDomain(row);
}

export async function removeDomain(db: Db, workspaceId: string, id: string) {
  const [deleted] = await db
    .delete(sendingDomains)
    .where(and(eq(sendingDomains.workspaceId, workspaceId), eq(sendingDomains.id, id)))
    .returning({ id: sendingDomains.id });
  return !!deleted;
}

export async function getDomainDns(db: Db, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(sendingDomains)
    .where(and(eq(sendingDomains.workspaceId, workspaceId), eq(sendingDomains.id, id)))
    .limit(1);
  if (!row) return null;
  return { domain: row.domain, records: (row.dnsRecords as StoredDnsRecord[]) ?? [] };
}

export async function getDeliverabilityMetrics(db: Db, workspaceId: string) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 29);
  thirtyDaysAgo.setUTCHours(0, 0, 0, 0);

  // All inboxes for this workspace
  const allInboxes = await db
    .select({
      id: inboxes.id,
      status: inboxes.status,
      warmupStatus: inboxes.warmupStatus,
      dailySendLimit: inboxes.dailySendLimit,
      sentCount: inboxes.sentCount,
      bounceCount: inboxes.bounceCount,
      spamCount: inboxes.spamCount,
    })
    .from(inboxes)
    .where(eq(inboxes.workspaceId, workspaceId));

  // Daily outbound message counts for warmup chart (last 30 days)
  const dailySent = await db
    .select({
      date: sql<string>`date_trunc('day', ${inboxMessages.sentAt})::date::text`,
      sent: count(inboxMessages.id),
    })
    .from(inboxMessages)
    .innerJoin(inboxThreads, eq(inboxMessages.threadId, inboxThreads.id))
    .innerJoin(inboxes, eq(inboxThreads.inboxId, inboxes.id))
    .where(
      and(
        eq(inboxes.workspaceId, workspaceId),
        eq(inboxMessages.direction, "outbound"),
        gte(inboxMessages.sentAt, thirtyDaysAgo),
      )
    )
    .groupBy(sql`date_trunc('day', ${inboxMessages.sentAt})::date`)
    .orderBy(sql`date_trunc('day', ${inboxMessages.sentAt})::date`);

  // Build warmup array — fill in gaps for days with no sends
  const sentByDate = Object.fromEntries(dailySent.map((r) => [r.date, Number(r.sent)]));
  const totalDailyLimit = allInboxes.reduce((acc, i) => acc + i.dailySendLimit, 0);
  const warmupRampTarget = Math.max(totalDailyLimit, 1);

  const warmup: Array<{ date: string; sent: number; target: number }> = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(thirtyDaysAgo);
    d.setUTCDate(d.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayFraction = (i + 1) / 30;
    warmup.push({
      date: dateStr,
      sent: sentByDate[dateStr] ?? 0,
      target: Math.round(warmupRampTarget * dayFraction),
    });
  }

  // Bounce / spam chart — one aggregate point per inbox, last 30 days
  // (we don't store daily bounce logs, so we surface total rates as a single point)
  const totalSent = allInboxes.reduce((acc, i) => acc + i.sentCount, 0);
  const totalBounce = allInboxes.reduce((acc, i) => acc + i.bounceCount, 0);
  const totalSpam = allInboxes.reduce((acc, i) => acc + i.spamCount, 0);

  const bounceRate = totalSent > 0 ? (totalBounce / totalSent) * 100 : 0;
  const spamRate = totalSent > 0 ? (totalSpam / totalSent) * 100 : 0;

  const bounce =
    totalSent > 0
      ? [{ date: now.toISOString().slice(0, 10), bounceRate, spamRate }]
      : [];

  // Summary
  const inboxCount = allInboxes.filter((i) => i.status === "active").length;
  const warmingCount = allInboxes.filter((i) => i.warmupStatus === "warming").length;

  return {
    warmup,
    bounce,
    summary: {
      totalSent,
      avgBounceRate: bounceRate,
      avgSpamRate: spamRate,
      inboxCount,
      warmingCount,
    },
  };
}

export async function createDomain(db: Db, workspaceId: string, domain: string) {
  const [row] = await db
    .insert(sendingDomains)
    .values({ workspaceId, domain: domain.toLowerCase().trim() })
    .onConflictDoUpdate({
      target: [sendingDomains.workspaceId, sendingDomains.domain],
      set: { updatedAt: new Date() },
    })
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Class-based InboxService (thread management, inbound ingestion, replies)
// ---------------------------------------------------------------------------

type RawInboxRow = typeof inboxes.$inferSelect;

function toPublicInbox(row: RawInboxRow) {
  const { smtpPasswordEncrypted, oauthAccessTokenEncrypted, oauthRefreshTokenEncrypted, ...rest } = row;
  return {
    ...rest,
    smtpConfigured: smtpPasswordEncrypted != null && smtpPasswordEncrypted.length > 0,
    oauthConfigured: oauthAccessTokenEncrypted != null && oauthAccessTokenEncrypted.length > 0,
  };
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
    // Require verification whenever credentials are provided
    const requiresVerification = !!(smtpPasswordEncrypted || input.smtpHost);
    const [row] = await this.db
      .insert(inboxes)
      .values({
        workspaceId,
        emailAddress: input.emailAddress,
        displayName: input.displayName ?? null,
        provider: input.provider ?? "smtp",
        dailySendLimit: input.dailySendLimit ?? 50,
        sendingDomainId: input.sendingDomainId ?? null,
        status: requiresVerification ? "pending_verification" : "active",
        smtpHost: input.smtpHost ?? null,
        smtpPort: input.smtpPort ?? null,
        smtpUsername: input.smtpUsername ?? null,
        smtpPasswordEncrypted,
        smtpSecure: input.smtpSecure ?? (input.smtpPort === 465),
        imapHost: input.imapHost ?? null,
        imapPort: input.imapPort ?? null,
      })
      .onConflictDoUpdate({
        target: [inboxes.workspaceId, inboxes.emailAddress],
        set: {
          provider: input.provider ?? "smtp",
          status: requiresVerification ? "pending_verification" : "active",
          smtpHost: input.smtpHost ?? null,
          smtpPort: input.smtpPort ?? null,
          smtpUsername: input.smtpUsername ?? null,
          smtpPasswordEncrypted,
          smtpSecure: input.smtpSecure ?? (input.smtpPort === 465),
          updatedAt: new Date(),
        },
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

  async testSend(workspaceId: string, inboxId: string): Promise<{ ok: true; provider: string }> {
    const [inbox] = await this.db
      .select()
      .from(inboxes)
      .where(and(eq(inboxes.workspaceId, workspaceId), eq(inboxes.id, inboxId)))
      .limit(1);
    if (!inbox) throw new HttpError("inbox_not_found", 404);

    const encKey = this.config.INTEGRATION_ENCRYPTION_KEY;
    if (!encKey) throw new HttpError("INTEGRATION_ENCRYPTION_KEY not configured", 503);

    let transporter: ReturnType<typeof nodemailer.createTransport>;

    const useOAuth =
      (inbox.provider === "google" || inbox.provider === "microsoft") &&
      !!inbox.oauthAccessTokenEncrypted;

    if (useOAuth) {
      const { resolveAccessToken } = await import("./inbox-oauth.service.js");
      const accessToken = await resolveAccessToken(inbox, this.db, this.config);

      const smtpConfig =
        inbox.provider === "google"
          ? { host: "smtp.gmail.com", port: 465, secure: true }
          : { host: "smtp.office365.com", port: 587, secure: false };

      const clientId =
        inbox.provider === "google" ? this.config.GOOGLE_CLIENT_ID : this.config.MICROSOFT_CLIENT_ID;
      const clientSecret =
        inbox.provider === "google" ? this.config.GOOGLE_CLIENT_SECRET : this.config.MICROSOFT_CLIENT_SECRET;

      transporter = nodemailer.createTransport({
        ...smtpConfig,
        auth: {
          type: "OAuth2",
          user: inbox.emailAddress,
          clientId,
          clientSecret,
          accessToken,
        },
      });
    } else {
      // SMTP credentials (plain password — covers generic SMTP and Google/Microsoft app-password setups)
      if (!inbox.smtpHost || !inbox.smtpPort || !inbox.smtpUsername || !inbox.smtpPasswordEncrypted) {
        throw new HttpError("inbox_smtp_not_configured", 422);
      }
      const password = decryptSecret(inbox.smtpPasswordEncrypted, encKey);
      transporter = nodemailer.createTransport({
        host: inbox.smtpHost,
        port: inbox.smtpPort,
        secure: inbox.smtpSecure,
        auth: { user: inbox.smtpUsername, pass: password },
      });
    }

    await transporter.verify();

    // Activate inbox after successful verification
    await this.db
      .update(inboxes)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(inboxes.id, inboxId));

    return { ok: true, provider: inbox.provider };
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
