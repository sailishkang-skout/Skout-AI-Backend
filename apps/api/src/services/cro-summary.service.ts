import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { buildDemoCorpus, searchProspects } from "@skout/opensearch";
import type { Env } from "../config/env.js";
import { openSearchConfigFromEnv } from "../lib/opensearch-config.js";

const {
  companies,
  contacts,
  deals,
  activities,
  users,
  tasks,
  prospectActivations,
  enrichmentResults,
  sequenceEnrollments,
  inboxThreads,
  inboxMessages,
} = schema;

const STALE_DEAL_DAYS = 14;

/**
 * R19.1/R19.2 — CRO Copilot's data source for the "get_cro_summary" chat tool. Deliberately a
 * self-contained query set (not a call into apps/crm's DashboardService) since apps/api and
 * apps/crm are separately deployed services that happen to share one Postgres — apps/api
 * already reads/writes CRM tables directly elsewhere in Phase 1 (see R20.3, R20.4) for the
 * same reason. Mirrors apps/crm/src/services/dashboard.service.ts#croSummary's shape closely
 * enough that the two won't drift in meaning, just not in code.
 */
export async function computeCroSummary(db: Db, workspaceId: string) {
  const [companyRows, contactRows, openDealRows, staleDealRows, repActivityRows, overdueTaskRows] = await Promise.all([
    db.select({ id: companies.id }).from(companies).where(and(eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt))),
    db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.workspaceId, workspaceId), isNull(contacts.deletedAt))),
    db
      .select({ amount: deals.amount, currency: deals.currency })
      .from(deals)
      .where(and(eq(deals.workspaceId, workspaceId), eq(deals.status, "open"), isNull(deals.deletedAt))),
    db
      .select({ id: deals.id, name: deals.name, amount: deals.amount, currency: deals.currency, updatedAt: deals.updatedAt })
      .from(deals)
      .where(
        and(
          eq(deals.workspaceId, workspaceId),
          eq(deals.status, "open"),
          isNull(deals.deletedAt),
          lt(deals.updatedAt, sql`now() - interval '${sql.raw(String(STALE_DEAL_DAYS))} days'`)
        )
      )
      .orderBy(deals.updatedAt)
      .limit(10),
    db
      .select({
        name: sql<string>`coalesce(${users.fullName}, ${users.email}, 'Unassigned')`,
        activityCount7d: sql<number>`count(*)`,
      })
      .from(activities)
      .leftJoin(users, eq(users.id, activities.ownerId))
      .where(and(eq(activities.workspaceId, workspaceId), sql`${activities.occurredAt} >= now() - interval '7 days'`))
      .groupBy(users.fullName, users.email)
      .orderBy(desc(sql`count(*)`))
      .limit(10),
    db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.status, "open"),
          isNull(tasks.deletedAt),
          sql`${tasks.dueDate} < now()`
        )
      ),
  ]);

  const pipelineValue = openDealRows.reduce((sum, d) => sum + (d.amount ? Number(d.amount) : 0), 0);
  const currency = openDealRows[0]?.currency ?? "USD";

  return {
    companies: companyRows.length,
    contacts: contactRows.length,
    openDeals: openDealRows.length,
    pipelineValue,
    currency,
    overdueTasks: overdueTaskRows.length,
    staleDeals: staleDealRows.map((d) => ({
      name: d.name,
      amount: d.amount ? Number(d.amount) : null,
      currency: d.currency,
      daysSinceUpdate: Math.floor((Date.now() - d.updatedAt.getTime()) / (1000 * 60 * 60 * 24)),
    })),
    repActivity7d: repActivityRows.map((r) => ({ name: r.name, activityCount: Number(r.activityCount7d) })),
  };
}

export interface CroRollup {
  tamCoverage: {
    /** Total addressable market — corpus size (OpenSearch, or the local demo corpus when
     * OPENSEARCH_URL is unset). Not yet ICP-filtered (that precise definition is R12.2, not
     * built in this pass) — a real, non-fabricated number, just a broader "total" than a fully
     * ICP-scoped TAM would be. */
    total: number;
    activated: number;
    enriched: number;
    contacted: number;
    replied: number;
    dealCreated: number;
  };
  activationRate: number;
  responseRate: number;
  /** Where the TAM total came from — surfaced in the board-pack export's data-scope disclosure
   * so a live-index number is never presented next to a demo-corpus number without saying so. */
  tamSource: "opensearch" | "demo_corpus";
  topAtRiskAccounts: Array<{
    companyId: string;
    name: string;
    pipelineValue: number;
    currency: string;
    /** null = no activity ever logged for this account. */
    daysSinceLastActivity: number | null;
  }>;
  pipelineValue: number;
  currency: string;
  openDeals: number;
}

/**
 * R19.1 — the exact `GET /api/v1/cro/summary` metrics the AC asks for: activation rate,
 * response rate, top at-risk accounts, TAM coverage. Distinct from `computeCroSummary` above
 * (which feeds the CRO Copilot chat tool with a different, chat-oriented shape) — this is the
 * literal rollup contract.
 *
 * "At-risk" reuses R18.1's own definition ("no opens/replies/activity over a rolling window")
 * against data that already exists (`activities`), rather than waiting on R18.1's separate risk
 * score column — computed live, capped to the top 50 accounts by pipeline value to bound work.
 */
export async function computeCroRollup(db: Db, config: Env, workspaceId: string): Promise<CroRollup> {
  const [activatedRows, enrichedRows, contactedRows, repliedRows, openDealRows] = await Promise.all([
    db.selectDistinct({ prospectId: prospectActivations.prospectId }).from(prospectActivations).where(eq(prospectActivations.workspaceId, workspaceId)),
    db.selectDistinct({ prospectId: enrichmentResults.prospectId }).from(enrichmentResults).where(eq(enrichmentResults.workspaceId, workspaceId)),
    db.selectDistinct({ prospectId: sequenceEnrollments.prospectId }).from(sequenceEnrollments).where(eq(sequenceEnrollments.workspaceId, workspaceId)),
    db
      .selectDistinct({ prospectId: inboxThreads.prospectId })
      .from(inboxThreads)
      .innerJoin(inboxMessages, eq(inboxMessages.threadId, inboxThreads.id))
      .where(and(eq(inboxThreads.workspaceId, workspaceId), eq(inboxMessages.direction, "inbound"))),
    db
      .select({ id: deals.id, companyId: deals.companyId, amount: deals.amount, currency: deals.currency })
      .from(deals)
      .where(and(eq(deals.workspaceId, workspaceId), eq(deals.status, "open"), isNull(deals.deletedAt))),
  ]);

  let tamTotal = 0;
  let tamSource: CroRollup["tamSource"] = "demo_corpus";
  const osCfg = openSearchConfigFromEnv(config);
  if (osCfg) {
    try {
      const res = await searchProspects(osCfg, {}, 1, 1);
      tamTotal = res.total;
      tamSource = "opensearch";
    } catch {
      tamTotal = 0;
    }
  } else {
    tamTotal = buildDemoCorpus(config.DEMO_CORPUS_SIZE).length;
  }

  const activated = activatedRows.length;
  const enriched = enrichedRows.length;
  const contacted = contactedRows.length;
  const replied = repliedRows.length;

  const pipelineByCompany = new Map<string, { value: number; currency: string; dealIds: string[] }>();
  for (const d of openDealRows) {
    if (!d.companyId) continue;
    const entry = pipelineByCompany.get(d.companyId) ?? { value: 0, currency: d.currency, dealIds: [] };
    entry.value += d.amount ? Number(d.amount) : 0;
    entry.dealIds.push(d.id);
    pipelineByCompany.set(d.companyId, entry);
  }

  // Bound the per-account activity-recency work to the accounts that matter most.
  const candidateCompanyIds = [...pipelineByCompany.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .slice(0, 50)
    .map(([id]) => id);

  const [companyRows, contactRows] = await Promise.all([
    candidateCompanyIds.length
      ? db.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, candidateCompanyIds))
      : Promise.resolve([]),
    candidateCompanyIds.length
      ? db.select({ id: contacts.id, companyId: contacts.companyId }).from(contacts).where(inArray(contacts.companyId, candidateCompanyIds))
      : Promise.resolve([]),
  ]);

  const contactIdsByCompany = new Map<string, string[]>();
  for (const c of contactRows) {
    if (!c.companyId) continue;
    const arr = contactIdsByCompany.get(c.companyId) ?? [];
    arr.push(c.id);
    contactIdsByCompany.set(c.companyId, arr);
  }

  const atRisk = await Promise.all(
    candidateCompanyIds.map(async (companyId) => {
      const pipeline = pipelineByCompany.get(companyId)!;
      const entityIds = [companyId, ...pipeline.dealIds, ...(contactIdsByCompany.get(companyId) ?? [])];
      const [row] = await db
        .select({ lastActivity: sql<Date | null>`max(${activities.occurredAt})` })
        .from(activities)
        .where(and(eq(activities.workspaceId, workspaceId), inArray(activities.entityId, entityIds)));
      const lastActivity = row?.lastActivity ? new Date(row.lastActivity) : null;
      const daysSinceLastActivity = lastActivity ? Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24)) : null;
      const company = companyRows.find((c) => c.id === companyId);
      return {
        companyId,
        name: company?.name ?? "Unknown",
        pipelineValue: pipeline.value,
        currency: pipeline.currency,
        daysSinceLastActivity,
      };
    })
  );

  const topAtRiskAccounts = atRisk
    .sort((a, b) => (b.daysSinceLastActivity ?? Number.MAX_SAFE_INTEGER) - (a.daysSinceLastActivity ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 10);

  const pipelineValue = openDealRows.reduce((sum, d) => sum + (d.amount ? Number(d.amount) : 0), 0);
  const currency = openDealRows[0]?.currency ?? "USD";
  const dealCreated = new Set(openDealRows.map((d) => d.companyId).filter((id): id is string => Boolean(id))).size;

  return {
    tamCoverage: { total: tamTotal, activated, enriched, contacted, replied, dealCreated },
    activationRate: tamTotal > 0 ? activated / tamTotal : 0,
    responseRate: contacted > 0 ? replied / contacted : 0,
    tamSource,
    topAtRiskAccounts,
    pipelineValue,
    currency,
    openDeals: openDealRows.length,
  };
}
