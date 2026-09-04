import { Worker, Queue } from "bullmq";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { createNotification } from "../services/notifications.service.js";
import { listSignalsForEntities } from "../services/signal.service.js";

const log = createLogger("retention-signals-sweep.worker");

const QUEUE_NAME = "retention-signals-sweep";

/**
 * §7.1 / §5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md (Wave 3).
 *   - Tables touched directly: companies, deals, contacts, activities, meetings (owned by
 *     apps/crm) — read only
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: a periodic BullMQ sweep job, same shape as reminder-sweep.worker.ts and
 *     risk-decay-sweep.worker.ts (both already-documented exceptions) — an HTTP round trip into
 *     apps/crm per sweep tick, per workspace, per candidate account would add latency and a new
 *     failure mode for what is a read-only scan.
 *   - Review date: revisit once apps/crm's internal API surface covers bulk account/deal scans
 *     (Wave 2, see ADR 0003).
 */

type Db = ReturnType<typeof createDb>["db"];

/**
 * §8.12 CRM Intelligence (SS-02) — hiring/funding-shaped growth signals worth surfacing as an
 * "expansion" flag on an existing customer. `headcount_growth` is the one producer that's
 * actually wired today (workers/scrapers/ingestor/src/growth.ts); `recent_hiring`/
 * `recent_funding`/`funding_round` are included because they're named in this signal's own
 * schema-comment enumeration (packages/db/src/schema/scrape.ts) even though no producer writes
 * them yet — keeping them here means this flag picks them up automatically the day one does,
 * with no change needed here.
 */
const EXPANSION_SIGNAL_TYPES = new Set(["headcount_growth", "recent_hiring", "recent_funding", "funding_round"]);

const DISENGAGEMENT_NOTIFICATION_TYPE = "retention_disengagement_risk";
const RENEWAL_RISK_NOTIFICATION_TYPE = "retention_renewal_risk";
const EXPANSION_NOTIFICATION_TYPE = "retention_expansion_opportunity";

function daysAgo(days: number, from: Date = new Date()): Date {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
}

function daysFromNow(days: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Most recent notification of `type` for `entityId`, if any — dedupe guard shared by all three sweeps. */
async function mostRecentNotification(
  db: Db,
  workspaceId: string,
  type: string,
  entityType: string,
  entityId: string
): Promise<Date | null> {
  const { notifications } = schema;
  const [row] = await db
    .select({ createdAt: notifications.createdAt })
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.type, type),
        eq(notifications.entityType, entityType),
        eq(notifications.entityId, entityId)
      )
    )
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
}

export interface DisengagementCandidate {
  companyId: string;
  companyName: string;
  ownerId: string | null;
  lastActivityAt: Date | null;
  daysSinceActivity: number;
}

/**
 * Disengagement: active/customer accounts with no activity (across the company itself, its
 * deals, and its contacts — same "account-level" definition cro-summary.service.ts's
 * computeCroRollup already uses) in `inactivityDays`. Reuses the `activities` table as-is; no
 * new data collection.
 */
export async function computeDisengagementCandidates(
  db: Db,
  workspaceId: string,
  inactivityDays: number
): Promise<DisengagementCandidate[]> {
  const { companies, deals, contacts, activities } = schema;
  const now = new Date();
  const inactivityCutoff = daysAgo(inactivityDays, now);

  const accounts = await db
    .select({ id: companies.id, name: companies.name, ownerId: companies.ownerId, createdAt: companies.createdAt })
    .from(companies)
    .where(
      and(eq(companies.workspaceId, workspaceId), inArray(companies.status, ["active", "customer"]), isNull(companies.deletedAt))
    );
  const liveAccounts = accounts.filter((a) => a.createdAt <= inactivityCutoff);
  if (liveAccounts.length === 0) return [];

  const companyIds = liveAccounts.map((a) => a.id);
  const [dealRows, contactRows] = await Promise.all([
    db
      .select({ id: deals.id, companyId: deals.companyId })
      .from(deals)
      .where(and(eq(deals.workspaceId, workspaceId), inArray(deals.companyId, companyIds), isNull(deals.deletedAt))),
    db
      .select({ id: contacts.id, companyId: contacts.companyId })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), inArray(contacts.companyId, companyIds), isNull(contacts.deletedAt))),
  ]);

  const entityIdsByCompany = new Map<string, string[]>();
  for (const id of companyIds) entityIdsByCompany.set(id, [id]);
  for (const d of dealRows) {
    if (!d.companyId) continue;
    entityIdsByCompany.get(d.companyId)?.push(d.id);
  }
  for (const c of contactRows) {
    if (!c.companyId) continue;
    entityIdsByCompany.get(c.companyId)?.push(c.id);
  }

  const allEntityIds = [...entityIdsByCompany.values()].flat();
  const activityRows =
    allEntityIds.length === 0
      ? []
      : await db
          .select({ entityId: activities.entityId, lastAt: activities.occurredAt })
          .from(activities)
          .where(and(eq(activities.workspaceId, workspaceId), inArray(activities.entityId, allEntityIds)))
          .orderBy(desc(activities.occurredAt));

  const lastActivityByEntity = new Map<string, Date>();
  for (const row of activityRows) {
    if (!lastActivityByEntity.has(row.entityId)) lastActivityByEntity.set(row.entityId, row.lastAt);
  }

  const candidates: DisengagementCandidate[] = [];
  for (const account of liveAccounts) {
    const entityIds = entityIdsByCompany.get(account.id) ?? [account.id];
    const dates = entityIds.map((id) => lastActivityByEntity.get(id)).filter((d): d is Date => d != null);
    const lastActivityAt = dates.length === 0 ? null : dates.reduce((max, d) => (d > max ? d : max), dates[0]!);
    const isDisengaged = !lastActivityAt || lastActivityAt < inactivityCutoff;
    if (!isDisengaged) continue;

    const daysSinceActivity = lastActivityAt
      ? Math.floor((now.getTime() - lastActivityAt.getTime()) / (24 * 60 * 60 * 1000))
      : inactivityDays;
    candidates.push({ companyId: account.id, companyName: account.name, ownerId: account.ownerId, lastActivityAt, daysSinceActivity });
  }
  return candidates;
}

export async function sweepDisengagement(db: Db, config: Env, workspaceId: string, inactivityDays: number): Promise<number> {
  const candidates = await computeDisengagementCandidates(db, workspaceId, inactivityDays);
  let flagged = 0;
  for (const candidate of candidates) {
    const recent = await mostRecentNotification(db, workspaceId, DISENGAGEMENT_NOTIFICATION_TYPE, "company", candidate.companyId);
    if (recent && recent > daysAgo(inactivityDays)) continue; // already flagged within this inactivity window

    try {
      await createNotification(db, config, {
        workspaceId,
        userId: candidate.ownerId,
        type: DISENGAGEMENT_NOTIFICATION_TYPE,
        entityType: "company",
        entityId: candidate.companyId,
        title: `${candidate.companyName} has gone quiet`,
        body: candidate.lastActivityAt
          ? `No activity in ${candidate.daysSinceActivity} days (last activity: ${candidate.lastActivityAt.toISOString().slice(0, 10)}).`
          : `No activity recorded on this account since it was created.`,
      });
      flagged++;
    } catch (err) {
      log.error(`Failed to create disengagement notification for company ${candidate.companyId}`, { companyId: candidate.companyId, err });
    }
  }
  return flagged;
}

export interface RenewalRiskCandidate {
  dealId: string;
  dealName: string;
  companyId: string | null;
  ownerId: string | null;
  contractEndDate: string;
}

/**
 * Renewal risk: won deals whose `contractEndDate` falls within `renewalWindowDays` (including
 * already-passed dates — an overdue renewal is more urgent, not less) with no recent positive
 * signal — a meeting tied to the deal/account, or a positive-tagged inbound reply on the
 * account's corpus thread — inside `positiveSignalLookbackDays`.
 */
export async function computeRenewalRiskCandidates(
  db: Db,
  workspaceId: string,
  renewalWindowDays: number,
  positiveSignalLookbackDays: number
): Promise<RenewalRiskCandidate[]> {
  const { deals, companies, meetings, inboxThreads } = schema;
  const now = new Date();
  const windowEnd = daysFromNow(renewalWindowDays, now).toISOString().slice(0, 10);
  const positiveCutoff = daysAgo(positiveSignalLookbackDays, now);

  const dueDeals = await db
    .select({
      id: deals.id,
      name: deals.name,
      companyId: deals.companyId,
      ownerId: deals.ownerId,
      contractEndDate: deals.contractEndDate,
    })
    .from(deals)
    .where(
      and(
        eq(deals.workspaceId, workspaceId),
        eq(deals.status, "won"),
        isNull(deals.deletedAt),
        lte(deals.contractEndDate, windowEnd)
      )
    );
  const candidates = dueDeals.filter((d): d is typeof d & { contractEndDate: string } => d.contractEndDate !== null);
  if (candidates.length === 0) return [];

  const companyIds = [...new Set(candidates.map((d) => d.companyId).filter((id): id is string => id !== null))];
  const dealIds = candidates.map((d) => d.id);

  const [recentMeetings, sourceCompanies] = await Promise.all([
    dealIds.length === 0 && companyIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ dealId: meetings.dealId, companyId: meetings.companyId })
          .from(meetings)
          .where(
            and(
              eq(meetings.workspaceId, workspaceId),
              isNull(meetings.deletedAt),
              gte(meetings.scheduledAt, positiveCutoff)
            )
          ),
    companyIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: companies.id, sourceProspectCompanyId: companies.sourceProspectCompanyId })
          .from(companies)
          .where(inArray(companies.id, companyIds)),
  ]);

  const meetingByDeal = new Set(recentMeetings.map((m) => m.dealId).filter((id): id is string => id !== null));
  const meetingByCompany = new Set(recentMeetings.map((m) => m.companyId).filter((id): id is string => id !== null));

  const corpusIdByCompany = new Map<string, string>();
  const corpusIds: string[] = [];
  for (const c of sourceCompanies) {
    if (c.sourceProspectCompanyId) {
      corpusIdByCompany.set(c.id, c.sourceProspectCompanyId);
      corpusIds.push(c.sourceProspectCompanyId);
    }
  }

  const positiveReplyCorpusIds = new Set<string>();
  if (corpusIds.length > 0) {
    const positiveThreads = await db
      .select({ prospectId: inboxThreads.prospectId })
      .from(inboxThreads)
      .where(
        and(
          eq(inboxThreads.workspaceId, workspaceId),
          eq(inboxThreads.replyTag, "positive"),
          gte(inboxThreads.lastMessageAt, positiveCutoff)
        )
      );
    for (const t of positiveThreads) {
      if (t.prospectId) positiveReplyCorpusIds.add(t.prospectId);
    }
  }

  return candidates
    .filter((deal) => {
      if (deal.id && meetingByDeal.has(deal.id)) return false;
      if (deal.companyId && meetingByCompany.has(deal.companyId)) return false;
      const corpusId = deal.companyId ? corpusIdByCompany.get(deal.companyId) : undefined;
      if (corpusId && positiveReplyCorpusIds.has(corpusId)) return false;
      return true;
    })
    .map((deal) => ({
      dealId: deal.id,
      dealName: deal.name,
      companyId: deal.companyId,
      ownerId: deal.ownerId,
      contractEndDate: deal.contractEndDate,
    }));
}

export async function sweepRenewalRisk(
  db: Db,
  config: Env,
  workspaceId: string,
  renewalWindowDays: number,
  positiveSignalLookbackDays: number
): Promise<number> {
  const candidates = await computeRenewalRiskCandidates(db, workspaceId, renewalWindowDays, positiveSignalLookbackDays);
  let flagged = 0;
  for (const candidate of candidates) {
    const recent = await mostRecentNotification(db, workspaceId, RENEWAL_RISK_NOTIFICATION_TYPE, "deal", candidate.dealId);
    if (recent && recent > daysAgo(positiveSignalLookbackDays)) continue;

    try {
      await createNotification(db, config, {
        workspaceId,
        userId: candidate.ownerId,
        type: RENEWAL_RISK_NOTIFICATION_TYPE,
        entityType: "deal",
        entityId: candidate.dealId,
        title: `"${candidate.dealName}" is up for renewal soon`,
        body: `Contract end date ${candidate.contractEndDate}, with no recent reply or meeting on this account.`,
      });
      flagged++;
    } catch (err) {
      log.error(`Failed to create renewal-risk notification for deal ${candidate.dealId}`, { dealId: candidate.dealId, err });
    }
  }
  return flagged;
}

export interface ExpansionCandidate {
  companyId: string;
  companyName: string;
  ownerId: string | null;
  signalType: string;
  detectedAt: string;
}

/**
 * Expansion: an existing customer account (companies.status = "customer") gets a new
 * hiring/funding-shaped signal. Reuses signal.service.ts's listSignalsForEntities as-is — no new
 * signal-detection logic — and just filters the workspace's customer accounts' existing signal
 * timelines down to the growth-shaped subset detected within `expansionLookbackDays`.
 */
export async function computeExpansionCandidates(
  db: Db,
  workspaceId: string,
  expansionLookbackDays: number
): Promise<ExpansionCandidate[]> {
  const { companies } = schema;
  const lookbackCutoff = daysAgo(expansionLookbackDays);

  const customers = await db
    .select({ id: companies.id, name: companies.name, ownerId: companies.ownerId, sourceProspectCompanyId: companies.sourceProspectCompanyId })
    .from(companies)
    .where(and(eq(companies.workspaceId, workspaceId), eq(companies.status, "customer"), isNull(companies.deletedAt)));

  const customersWithCorpusId = customers.filter(
    (c): c is typeof c & { sourceProspectCompanyId: string } => c.sourceProspectCompanyId !== null
  );
  if (customersWithCorpusId.length === 0) return [];

  const corpusIds = customersWithCorpusId.map((c) => c.sourceProspectCompanyId);
  const signalsByEntity = await listSignalsForEntities(db, corpusIds);

  const candidates: ExpansionCandidate[] = [];
  for (const customer of customersWithCorpusId) {
    const signals = signalsByEntity.get(customer.sourceProspectCompanyId) ?? [];
    const growthSignal = signals.find(
      (s) => EXPANSION_SIGNAL_TYPES.has(s.signalType) && new Date(s.detectedAt) >= lookbackCutoff
    );
    if (!growthSignal) continue;
    candidates.push({
      companyId: customer.id,
      companyName: customer.name,
      ownerId: customer.ownerId,
      signalType: growthSignal.signalType,
      detectedAt: growthSignal.detectedAt,
    });
  }
  return candidates;
}

export async function sweepExpansion(db: Db, config: Env, workspaceId: string, expansionLookbackDays: number): Promise<number> {
  const candidates = await computeExpansionCandidates(db, workspaceId, expansionLookbackDays);
  let flagged = 0;
  for (const candidate of candidates) {
    const recent = await mostRecentNotification(db, workspaceId, EXPANSION_NOTIFICATION_TYPE, "company", candidate.companyId);
    if (recent && recent > daysAgo(expansionLookbackDays)) continue;

    try {
      await createNotification(db, config, {
        workspaceId,
        userId: candidate.ownerId,
        type: EXPANSION_NOTIFICATION_TYPE,
        entityType: "company",
        entityId: candidate.companyId,
        title: `Expansion signal on ${candidate.companyName}`,
        body: `New ${candidate.signalType.replace(/_/g, " ")} signal detected on this existing customer (${candidate.detectedAt.slice(0, 10)}).`,
      });
      flagged++;
    } catch (err) {
      log.error(`Failed to create expansion notification for company ${candidate.companyId}`, { companyId: candidate.companyId, err });
    }
  }
  return flagged;
}

export async function sweepWorkspaceForRetentionSignals(
  db: Db,
  config: Env,
  workspaceId: string,
  thresholds: {
    disengagementInactivityDays: number;
    renewalWindowDays: number;
    positiveSignalLookbackDays: number;
    expansionLookbackDays: number;
  }
): Promise<{ disengagement: number; renewalRisk: number; expansion: number }> {
  const [disengagement, renewalRisk, expansion] = await Promise.all([
    sweepDisengagement(db, config, workspaceId, thresholds.disengagementInactivityDays),
    sweepRenewalRisk(db, config, workspaceId, thresholds.renewalWindowDays, thresholds.positiveSignalLookbackDays),
    sweepExpansion(db, config, workspaceId, thresholds.expansionLookbackDays),
  ]);
  return { disengagement, renewalRisk, expansion };
}

export async function startRetentionSignalsSweepWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — retention signals sweep worker disabled");
    return () => Promise.resolve();
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — retention signals sweep worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });

  const cronExpression = `0 */${config.RETENTION_SIGNALS_SWEEP_INTERVAL_HOURS} * * *`;
  await queue.upsertJobScheduler(
    "retention-signals-sweep-all",
    { pattern: cronExpression },
    { name: "retention-signals-sweep-all", data: {} }
  );

  const { db } = createDb(config.DATABASE_URL);
  const { workspaces } = schema;

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      // §11.3 Task 33 pattern — self-triggered on a cron schedule; root span (no upstream trace exists).
      await withSpan("retention-signals-sweep.tick", async () => {
        const allWorkspaces = await db.select({ id: workspaces.id }).from(workspaces);
        const totals = { disengagement: 0, renewalRisk: 0, expansion: 0 };
        for (const ws of allWorkspaces) {
          try {
            const result = await sweepWorkspaceForRetentionSignals(db, config, ws.id, {
              disengagementInactivityDays: config.RETENTION_DISENGAGEMENT_INACTIVITY_DAYS,
              renewalWindowDays: config.RETENTION_RENEWAL_WINDOW_DAYS,
              positiveSignalLookbackDays: config.RETENTION_POSITIVE_SIGNAL_LOOKBACK_DAYS,
              expansionLookbackDays: config.RETENTION_EXPANSION_LOOKBACK_DAYS,
            });
            totals.disengagement += result.disengagement;
            totals.renewalRisk += result.renewalRisk;
            totals.expansion += result.expansion;
          } catch (err) {
            log.error(`Retention signals sweep failed for workspace ${ws.id}`, { workspaceId: ws.id, err });
          }
        }
        if (totals.disengagement + totals.renewalRisk + totals.expansion > 0) {
          log.info("Retention signals sweep flagged accounts", totals);
        }
      });
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("Retention signals sweep job failed", { jobId: job?.id, err });
  });

  log.info(`Retention signals sweep worker started (cron: ${cronExpression})`);

  return async () => {
    await worker.close();
    await queue.close();
  };
}

if (
  process.argv[1]?.endsWith("retention-signals-sweep.worker.ts") ||
  process.argv[1]?.endsWith("retention-signals-sweep.worker.js")
) {
  const config = loadEnv();
  startRetentionSignalsSweepWorker(config).then(() => {
    log.info("Retention signals sweep worker running standalone");
  });
}
