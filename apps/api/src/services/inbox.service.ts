import { and, asc, count, desc, eq, exists, gt, gte, inArray, sql } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { encryptSecret, decryptSecret } from "@skout/shared";
import { HttpError } from "../utils/http.js";
import { markInboxUsed } from "./inbox-rotation.service.js";
import { applyReplyTagActions } from "./reply-tag-actions.service.js";
import type { NegativeSubtype, ReplyTag } from "./reply-tagger.service.js";
import { recordDecisionEvent } from "./model-performance.service.js";
import nodemailer from "nodemailer";
import { randomBytes } from "node:crypto";

const log = createLogger("inbox.service");
const { inboxes, inboxThreads, inboxMessages, sendingDomains, prospectActivations, prospectScores, sequences, sequenceEnrollments, aiDrafts } = schema;

type Db = ReturnType<typeof createDb>["db"];

export type ThreadStatus = "new" | "replied" | "bounced" | "meeting_booked" | "closed";

const ALLOWED_MANUAL_TRANSITIONS: Partial<Record<ThreadStatus, ThreadStatus[]>> = {
  replied: ["meeting_booked", "closed"],
  new: ["closed", "meeting_booked", "replied"],
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
  patch: { displayName?: string; dailySendLimit?: number; status?: string; sendingDomainId?: string | null }
) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.dailySendLimit !== undefined) set.dailySendLimit = patch.dailySendLimit;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.sendingDomainId !== undefined) set.sendingDomainId = patch.sendingDomainId;
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
    status: row.status,
    spfStatus: (byPurpose["SPF"] ?? "unknown") as StoredDnsRecord["status"],
    dkimStatus: (byPurpose["DKIM"] ?? "unknown") as StoredDnsRecord["status"],
    dmarcStatus: (byPurpose["DMARC"] ?? "unknown") as StoredDnsRecord["status"],
    mxStatus: (byPurpose["MX"] ?? "unknown") as StoredDnsRecord["status"],
    blacklistStatus: row.blacklistStatus,
    blacklistedOn: (row.blacklistedOn as string[]) ?? [],
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    dnsRecords: records,
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

export async function verifyDomain(db: Db, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(sendingDomains)
    .where(and(eq(sendingDomains.workspaceId, workspaceId), eq(sendingDomains.id, id)))
    .limit(1);
  if (!row) return null;

  const { checkDomainDns } = await import("./domain-dns.service.js");
  const result = await checkDomainDns(row.domain);

  const allPass = result.spf === "pass" && result.dkim === "pass" && result.dmarc === "pass" && result.mx === "pass";
  const now = new Date();

  const [updated] = await db
    .update(sendingDomains)
    .set({
      dnsRecords: result.records,
      status: allPass ? "verified" : "pending_verification",
      verifiedAt: allPass ? now : row.verifiedAt,
      updatedAt: now,
    })
    .where(eq(sendingDomains.id, id))
    .returning();

  return updated ? shapeDomain(updated) : null;
}

/** Warmup daily limit schedule (mirrors warmup-ramp.worker). */
function warmupDailyLimit(warmupDay: number, maxLimit: number): number {
  let limit: number;
  if (warmupDay <= 0) limit = 0;
  else if (warmupDay <= 7) limit = warmupDay * 5;
  else if (warmupDay <= 14) limit = 7 * 5 + (warmupDay - 7) * 10;
  else limit = 7 * 5 + 7 * 10 + (warmupDay - 14) * 20;
  return Math.min(limit, maxLimit);
}

export async function getDeliverabilityMetrics(db: Db, workspaceId: string) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 29);
  thirtyDaysAgo.setUTCHours(0, 0, 0, 0);

  const allInboxes = await db
    .select({
      id: inboxes.id,
      status: inboxes.status,
      warmupStatus: inboxes.warmupStatus,
      warmupDay: inboxes.warmupDay,
      dailySendLimit: inboxes.dailySendLimit,
      sentCount: inboxes.sentCount,
      bounceCount: inboxes.bounceCount,
      spamCount: inboxes.spamCount,
    })
    .from(inboxes)
    .where(eq(inboxes.workspaceId, workspaceId));

  // Daily outbound message counts (source of truth for volume)
  const dailySent = await db
    .select({
      date: sql<string>`(date_trunc('day', ${inboxMessages.sentAt} AT TIME ZONE 'UTC'))::date::text`,
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
    .groupBy(sql`(date_trunc('day', ${inboxMessages.sentAt} AT TIME ZONE 'UTC'))::date`)
    .orderBy(sql`(date_trunc('day', ${inboxMessages.sentAt} AT TIME ZONE 'UTC'))::date`);

  // Daily bounce / spam classifications from inbound messages
  const dailyBounceSpam = await db
    .select({
      date: sql<string>`(date_trunc('day', ${inboxMessages.sentAt} AT TIME ZONE 'UTC'))::date::text`,
      bounce: sql<number>`count(*) filter (where ${inboxMessages.classification} = 'bounce')`,
      spam: sql<number>`count(*) filter (where ${inboxMessages.classification} = 'spam')`,
    })
    .from(inboxMessages)
    .innerJoin(inboxThreads, eq(inboxMessages.threadId, inboxThreads.id))
    .innerJoin(inboxes, eq(inboxThreads.inboxId, inboxes.id))
    .where(
      and(
        eq(inboxes.workspaceId, workspaceId),
        eq(inboxMessages.direction, "inbound"),
        gte(inboxMessages.sentAt, thirtyDaysAgo),
      )
    )
    .groupBy(sql`(date_trunc('day', ${inboxMessages.sentAt} AT TIME ZONE 'UTC'))::date`)
    .orderBy(sql`(date_trunc('day', ${inboxMessages.sentAt} AT TIME ZONE 'UTC'))::date`);

  const sentByDate = Object.fromEntries(dailySent.map((r) => [r.date, Number(r.sent)]));
  const bounceByDate = Object.fromEntries(
    dailyBounceSpam.map((r) => [r.date, { bounce: Number(r.bounce), spam: Number(r.spam) }])
  );

  // Daily capacity target: warmup schedule for warming inboxes, else sum of daily limits
  const warming = allInboxes.filter((i) => i.warmupStatus === "warming");
  const targetBase =
    warming.length > 0
      ? warming.reduce((acc, i) => acc + warmupDailyLimit(i.warmupDay || 1, i.dailySendLimit), 0)
      : allInboxes
          .filter((i) => i.status === "active" || i.status === "warming")
          .reduce((acc, i) => acc + i.dailySendLimit, 0);

  const warmup: Array<{ date: string; sent: number; target: number }> = [];
  const bounce: Array<{
    date: string;
    bounceRate: number;
    spamRate: number;
    sent: number;
    bounces: number;
    spam: number;
  }> = [];

  for (let i = 0; i < 30; i++) {
    const d = new Date(thirtyDaysAgo);
    d.setUTCDate(d.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const sent = sentByDate[dateStr] ?? 0;
    const dayBounce = bounceByDate[dateStr]?.bounce ?? 0;
    const daySpam = bounceByDate[dateStr]?.spam ?? 0;
    // Flat daily capacity line (not a fake historical ramp of today's limit)
    warmup.push({
      date: dateStr,
      sent,
      target: Math.max(0, targetBase),
    });
    bounce.push({
      date: dateStr,
      sent,
      bounces: dayBounce,
      spam: daySpam,
      bounceRate: sent > 0 ? (dayBounce / sent) * 100 : 0,
      spamRate: sent > 0 ? (daySpam / sent) * 100 : 0,
    });
  }

  // Summary uses the same 30-day message window as the charts (not mixed with lifetime counters)
  const messagesSent30d = warmup.reduce((acc, d) => acc + d.sent, 0);
  const bounces30d = bounce.reduce((acc, d) => acc + d.bounces, 0);
  const spamClassified30d = bounce.reduce((acc, d) => acc + d.spam, 0);
  // Spam is rarely classified on inbound; fall back to lifetime inbox counters for the rate card
  const counterSent = allInboxes.reduce((acc, i) => acc + i.sentCount, 0);
  const counterSpam = allInboxes.reduce((acc, i) => acc + i.spamCount, 0);
  const counterBounce = allInboxes.reduce((acc, i) => acc + i.bounceCount, 0);

  const bounceRate =
    messagesSent30d > 0
      ? (bounces30d / messagesSent30d) * 100
      : counterSent > 0
        ? (counterBounce / counterSent) * 100
        : 0;
  const spamRate =
    messagesSent30d > 0 && spamClassified30d > 0
      ? (spamClassified30d / messagesSent30d) * 100
      : counterSent > 0
        ? (counterSpam / counterSent) * 100
        : 0;

  const inboxCount = allInboxes.filter((i) => i.status === "active").length;
  const warmingCount = warming.length;

  return {
    warmup,
    bounce,
    summary: {
      totalSent: messagesSent30d,
      sentLast30Days: messagesSent30d,
      lifetimeSent: counterSent,
      avgBounceRate: bounceRate,
      avgSpamRate: spamRate,
      bounceCount30d: bounces30d,
      spamCount30d: Math.max(spamClassified30d, 0),
      inboxCount,
      warmingCount,
      dailyCapacity: targetBase,
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
    if (row) {
      log.info("inbox created", {
        workspaceId,
        inboxId: row.id,
        provider: row.provider,
        status: row.status,
      });
    }
    return row ? toPublicInbox(row) : null;
  }

  async listThreads(
    workspaceId: string,
    options: {
      status?: ThreadStatus;
      unreadOnly?: boolean;
      inboxId?: string;
      folder?: "all" | "inbound" | "sent";
      limit?: number;
      offset?: number;
    } = {}
  ) {
    const conditions = [eq(inboxThreads.workspaceId, workspaceId)];

    if (options.inboxId) {
      conditions.push(eq(inboxThreads.inboxId, options.inboxId));
    }
    if (options.status) {
      conditions.push(eq(inboxThreads.status, options.status));
    }
    if (options.unreadOnly) {
      conditions.push(gt(inboxThreads.unreadCount, 0));
    }
    if (options.folder === "inbound") {
      // Threads that received at least one inbound message
      conditions.push(
        exists(
          this.db
            .select({ id: inboxMessages.id })
            .from(inboxMessages)
            .where(
              and(eq(inboxMessages.threadId, inboxThreads.id), eq(inboxMessages.direction, "inbound"))
            )
        )
      );
    } else if (options.folder === "sent") {
      // Any thread with an outbound send — including replies on inbound threads
      conditions.push(
        exists(
          this.db
            .select({ id: inboxMessages.id })
            .from(inboxMessages)
            .where(
              and(eq(inboxMessages.threadId, inboxThreads.id), eq(inboxMessages.direction, "outbound"))
            )
        )
      );
    }

    const limit = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;
    const where = and(...conditions);

    const [{ total }] = await this.db.select({ total: count() }).from(inboxThreads).where(where);

    const rows = await this.db
      .select()
      .from(inboxThreads)
      .where(where)
      .orderBy(desc(inboxThreads.lastMessageAt), desc(inboxThreads.updatedAt))
      .limit(limit)
      .offset(offset);

    const prospectIds = [...new Set(rows.map((r) => r.prospectId).filter((id): id is string => !!id))];
    const prospectById = new Map<
      string,
      { fullName?: string; companyName?: string; email?: string; title?: string; icpBand?: string | null }
    >();

    if (prospectIds.length > 0) {
      const activations = await this.db
        .select({
          prospectId: prospectActivations.prospectId,
          snapshot: prospectActivations.snapshot,
        })
        .from(prospectActivations)
        .where(
          and(
            eq(prospectActivations.workspaceId, workspaceId),
            inArray(prospectActivations.prospectId, prospectIds)
          )
        );

      for (const a of activations) {
        const snap = (a.snapshot ?? {}) as Record<string, unknown>;
        prospectById.set(a.prospectId, {
          fullName: typeof snap.fullName === "string" ? snap.fullName : undefined,
          companyName: typeof snap.companyName === "string" ? snap.companyName : undefined,
          email: typeof snap.email === "string" ? snap.email : undefined,
          title: typeof snap.title === "string" ? snap.title : undefined,
        });
      }

      const scores = await this.db
        .select({
          prospectId: prospectScores.prospectId,
          priority: prospectScores.priority,
        })
        .from(prospectScores)
        .where(
          and(eq(prospectScores.workspaceId, workspaceId), inArray(prospectScores.prospectId, prospectIds))
        );
      for (const s of scores) {
        const existing = prospectById.get(s.prospectId) ?? {};
        prospectById.set(s.prospectId, { ...existing, icpBand: s.priority ?? null });
      }
    }

    // Latest message from-address for display when no prospect name
    const threadIds = rows.map((r) => r.id);
    const latestFromByThread = new Map<string, string>();
    if (threadIds.length > 0) {
      const latestMsgs = await this.db
        .select({
          threadId: inboxMessages.threadId,
          fromAddress: inboxMessages.fromAddress,
          direction: inboxMessages.direction,
          sentAt: inboxMessages.sentAt,
        })
        .from(inboxMessages)
        .where(inArray(inboxMessages.threadId, threadIds))
        .orderBy(desc(inboxMessages.sentAt));

      for (const m of latestMsgs) {
        if (!latestFromByThread.has(m.threadId)) {
          latestFromByThread.set(m.threadId, m.fromAddress);
        }
      }
    }

    const data = rows.map((row) => {
      const prospect = row.prospectId ? prospectById.get(row.prospectId) : undefined;
      const fromHint = latestFromByThread.get(row.id);
      return {
        ...row,
        prospect: prospect
          ? {
              fullName: prospect.fullName ?? fromHint ?? "Unknown",
              companyName: prospect.companyName ?? null,
              email: prospect.email ?? null,
              title: prospect.title ?? null,
              icpBand: prospect.icpBand ?? null,
            }
          : fromHint
            ? { fullName: fromHint, companyName: null, email: fromHint, title: null, icpBand: null }
            : null,
      };
    });

    return { workspaceId, data, total, limit, offset };
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

    const pausedStatuses = new Set(["replied", "bounced", "completed", "paused", "stopped"]);
    const sequencePaused =
      sequence != null && pausedStatuses.has(sequence.enrollmentStatus);

    let suggestedDraft = null;
    const [pendingDraft] = await this.db
      .select({
        id: aiDrafts.id,
        subject: aiDrafts.subject,
        body: aiDrafts.body,
        status: aiDrafts.status,
        confidenceScore: aiDrafts.confidenceScore,
        createdAt: aiDrafts.createdAt,
      })
      .from(aiDrafts)
      .where(
        and(
          eq(aiDrafts.workspaceId, workspaceId),
          eq(aiDrafts.threadId, threadId),
          inArray(aiDrafts.status, ["pending_review", "edited", "approved"])
        )
      )
      .orderBy(desc(aiDrafts.createdAt))
      .limit(1);
    if (pendingDraft) suggestedDraft = pendingDraft;

    return { threadId, prospect, sequence, sequencePaused, suggestedDraft };
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
    log.info("thread status transitioned", {
      workspaceId,
      threadId,
      from: current,
      to: targetStatus,
    });
    return updated!;
  }

  /** Manual review resolution (condition-engine spec §14/§41): threads where the AI's
   * classification confidence was too low to auto-apply the branch, awaiting a human decision. */
  async listManualReviewThreads(workspaceId: string) {
    const rows = await this.db
      .select()
      .from(inboxThreads)
      .where(and(eq(inboxThreads.workspaceId, workspaceId), eq(inboxThreads.needsReview, true)))
      .orderBy(desc(inboxThreads.updatedAt));
    return { workspaceId, data: rows, total: rows.length };
  }

  async resolveManualReview(
    workspaceId: string,
    threadId: string,
    action: "apply" | "dismiss"
  ) {
    const thread = await this.getThread(workspaceId, threadId);
    if (!thread.needsReview) {
      throw new HttpError("not_pending_review", 422);
    }

    if (action === "apply" && thread.suggestedTag) {
      await applyReplyTagActions(this.db, this.config, workspaceId, threadId, thread.suggestedTag as ReplyTag, {
        negativeSubtype: (thread.suggestedNegativeSubtype ?? undefined) as NegativeSubtype | undefined,
        // A human just approved this — force the auto tier so the branch actually applies now,
        // rather than re-evaluating at the original (low) AI confidence and looping back here.
        confidence: 1,
      });
    }

    const now = new Date();
    await this.db
      .update(inboxThreads)
      .set({
        needsReview: false,
        suggestedTag: null,
        suggestedNegativeSubtype: null,
        suggestedConfidence: null,
        suggestedReason: null,
        updatedAt: now,
      })
      .where(and(eq(inboxThreads.workspaceId, workspaceId), eq(inboxThreads.id, threadId)));

    // 8.15 task 34 — model/prompt performance tracking (override rate / action acceptance).
    // Captured here, not read back from inboxThreads, because the update above clears
    // suggestedTag/suggestedConfidence — this is the only point where the comparison exists.
    await recordDecisionEvent(this.db, {
      workspaceId,
      surface: "reply_classification",
      suggestedValue: thread.suggestedTag,
      outcome: action === "apply" ? "accepted" : "overridden",
      confidence: thread.suggestedConfidence,
      metadata: { threadId },
    });

    log.info("manual review resolved", { workspaceId, threadId, action });
    return { ok: true, action };
  }

  async replyToThread(workspaceId: string, threadId: string, body: { text: string; html?: string }) {
    const thread = await this.getThread(workspaceId, threadId);
    const [inbox] = await this.db
      .select()
      .from(inboxes)
      .where(and(eq(inboxes.workspaceId, workspaceId), eq(inboxes.id, thread.inboxId)))
      .limit(1);

    if (!inbox) throw new HttpError("inbox_not_found", 404);

    const hasSmtp =
      !!inbox.smtpHost && !!inbox.smtpPort && !!inbox.smtpUsername && !!inbox.smtpPasswordEncrypted;
    const hasOAuth =
      (inbox.provider === "google" || inbox.provider === "microsoft") &&
      !!inbox.oauthAccessTokenEncrypted;
    if (!hasSmtp && !hasOAuth) {
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

    const { buildEmailSenderFromInbox } = await import("./email-sender.service.js");
    const transport = await buildEmailSenderFromInbox(this.config, inbox, this.db);

    const subject = thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`;

    await transport.send({
      from: inbox.emailAddress,
      fromName: inbox.displayName,
      to: replyTo,
      subject,
      text: body.text,
      html: body.html ?? body.text,
      messageId: newMessageId,
      inReplyTo,
      references: refs,
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

    await markInboxUsed(this.db, inbox.id);

    log.info("thread reply sent", {
      workspaceId,
      threadId,
      inboxId: inbox.id,
      messageId: inserted?.id,
    });

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
