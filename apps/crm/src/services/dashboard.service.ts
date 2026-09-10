import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { ActivitiesService, ActivityDto } from "./activities.service.js";
import type { CurrencyValue, DealsService } from "./deals.service.js";
import type { TasksService } from "./tasks.service.js";
import type { MeetingsService } from "./meetings.service.js";
import { serviceLog } from "../lib/obs.js";

const log = serviceLog("dashboard");
const {
  companies,
  contacts,
  deals,
  activities,
  users,
  crmProspectMappings,
  creditTransactions,
  buyingCommittees,
  buyingCommitteeMembers,
  signals,
  evidenceLedger,
} = schema;

export interface DashboardOverviewDto {
  workspaceId: string;
  companies: number;
  contacts: number;
  openDeals: number;
  valueByCurrency: CurrencyValue[];
  /** GTM revamp — Deal Distribution Donut. Already computed by DealsService.summary(); just
   * threaded through here instead of leaving it unused. */
  stages: { stageId: string; name: string; count: number; valueByCurrency: CurrencyValue[] }[];
  openTasks: number;
  overdueTasks: number;
  dueTodayTasks: number;
  upcomingMeetings: number;
  recentActivities: ActivityDto[];
}

const RECENT_ACTIVITIES_LIMIT = 5;

export interface SwitchingCostDto {
  workspaceId: string;
  totalContacts: number;
  nativeLinkedContacts: number;
  totalCompanies: number;
  nativeLinkedCompanies: number;
  /** % of contacts that carry a sourceProspectId — i.e. trace back to a Skout-native activation. */
  nativeLinkRatePct: number;
  /** Rows written to `crm_prospect_mappings` (provider="hubspot") in the trailing 7 days —
   * distinct prospects exported to HubSpot this week. R14.3. */
  hubspotExportVolume7d: number;
  /** `credit_transactions` rows with action="export_csv" in the trailing 7 days — CSV list
   * exports this week (one row per export call, see list-export.service.ts). R14.3. */
  csvExportVolume7d: number;
  note: string;
}

export interface StaleDealSummary {
  id: string;
  name: string;
  amount: number | null;
  currency: string;
  daysSinceUpdate: number;
}

export interface RepActivitySummary {
  userId: string | null;
  name: string;
  activityCount7d: number;
}

/** §8.12 CRM Intelligence — pipeline-risk flag for a Decision Maker who exists on the deal's
 * account (Account 360's buying-committee classification) but has no corresponding
 * buying_committee_members row on the deal itself. Evidence fields (accountRole/rule/computedAt)
 * follow the ticket's ask to carry "which role, which rule, when computed" alongside the flag. */
export interface MissingStakeholderFlag {
  dealId: string;
  dealName: string;
  companyId: string;
  contactId: string;
  contactName: string;
  /** The Account 360 buying-committee role that triggered this flag, e.g. "Decision Maker". */
  accountRole: string;
  /** Which detection rule raised this flag. */
  rule: string;
  /** ISO 8601 timestamp of when this flag was computed. */
  computedAt: string;
}

/** §SS-10 CRM Intelligence — disengagement risk flag for companies with no recent activity. */
export interface DisengagementFlag {
  id: string;
  companyId: string;
  companyName: string;
  daysSinceActivity: number;
  lastActivityAt: string | null;
  rule: string;
  computedAt: string;
}

/** §SS-10 CRM Intelligence — renewal risk flag for deals approaching their contract end date. */
export interface RenewalRiskFlag {
  id: string;
  dealId: string;
  dealName: string;
  companyId: string;
  companyName: string;
  contractEndDate: string;
  daysUntilExpiry: number;
  rule: string;
  computedAt: string;
  amount: number | null;
  currency: string;
}

/** §SS-10 CRM Intelligence — expansion signal flag for companies showing growth signals. */
export interface ExpansionSignalFlag {
  id: string;
  companyId: string;
  companyName: string;
  signalType: string;
  detectedAt: string;
  rule: string;
  computedAt: string;
}

/** R19.1 — admin-only exec rollup. Deliberately omits a "risk score" — R18 (risk detection)
 * doesn't exist yet, so "stale deals" (no update in 14+ days) stands in as an honest, real
 * signal rather than a fabricated one. See docs/tickets for the R18 dependency note. */
export interface CroSummaryDto {
  workspaceId: string;
  overview: DashboardOverviewDto;
  switchingCost: SwitchingCostDto;
  staleDeals: StaleDealSummary[];
  repActivity: RepActivitySummary[];
  generatedAt: string;
}

const STALE_DEAL_DAYS = 14;
const STALE_DEALS_LIMIT = 10;
const MISSING_STAKEHOLDER_DEALS_LIMIT = 200;
const MISSING_STAKEHOLDER_RULE = "decision_maker_not_linked_to_deal";
const DECISION_MAKER_ROLE = "Decision Maker";
// SS-10 CRM Intelligence retention flags constants
const DISENGAGEMENT_INACTIVITY_DAYS = 30;
const DISENGAGEMENT_FLAGS_LIMIT = 50;
const DISENGAGEMENT_RULE = "company_inactivity_exceeds_threshold";
const RENEWAL_WINDOW_DAYS = 60;
const RENEWAL_RISK_FLAGS_LIMIT = 50;
const RENEWAL_RISK_RULE = "contract_expiring_within_renewal_window";
const EXPANSION_LOOKBACK_DAYS = 14;
const EXPANSION_FLAGS_LIMIT = 50;
const EXPANSION_SIGNAL_RULE = "growth_signal_detected_recently";
const EXPANSION_SIGNAL_TYPES = new Set(["headcount_growth", "recent_hiring", "recent_funding", "funding_round"]);

/** Mirrors account-360.routes.ts's inline "Buying Committee Influence Map" title heuristic
 * (apps/api/src/routes/account-360.routes.ts) so this account-role signal doesn't require a
 * cross-service call — account-360 stays read-only/untouched per the ticket, and this is a
 * pure function of `contacts.title` with no persistence of its own. Keep in sync with that
 * file if the heuristic changes. */
function classifyAccountRole(title: string | null): string {
  const titleLower = (title ?? "").toLowerCase();
  if (
    titleLower.includes("vp") ||
    titleLower.includes("chief") ||
    titleLower.includes("head") ||
    titleLower.includes("ceo") ||
    titleLower.includes("cxo")
  ) {
    return DECISION_MAKER_ROLE;
  }
  if (titleLower.includes("director") || titleLower.includes("lead") || titleLower.includes("manager")) {
    return "Champion";
  }
  if (titleLower.includes("procurement") || titleLower.includes("legal") || titleLower.includes("security")) {
    return "Blocker / Gatekeeper";
  }
  return "Evaluator";
}

export class DashboardService {
  constructor(
    private readonly db: Db,
    private readonly dealsService: DealsService,
    private readonly tasksService: TasksService,
    private readonly activitiesService: ActivitiesService,
    private readonly meetingsService: MeetingsService | null
  ) {}

  async overview(workspaceId: string): Promise<DashboardOverviewDto> {
    const [companyRows, contactRows, dealsSummary, taskCounts, recentActivities, upcomingMeetings] =
      await Promise.all([
        this.db
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt))),
        this.db
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.workspaceId, workspaceId), isNull(contacts.deletedAt))),
        this.dealsService.summary(workspaceId),
        this.tasksService.counts(workspaceId),
        this.activitiesService.recent(workspaceId, RECENT_ACTIVITIES_LIMIT),
        this.meetingsService?.upcomingCount(workspaceId) ?? Promise.resolve(0),
      ]);

    const result: DashboardOverviewDto = {
      workspaceId,
      companies: companyRows.length,
      contacts: contactRows.length,
      openDeals: dealsSummary.openDeals,
      valueByCurrency: dealsSummary.valueByCurrency,
      stages: dealsSummary.stages,
      openTasks: taskCounts.open,
      overdueTasks: taskCounts.overdue,
      dueTodayTasks: taskCounts.dueToday,
      upcomingMeetings,
      recentActivities,
    };
    log.debug("dashboard overview loaded", {
      workspaceId,
      companies: result.companies,
      contacts: result.contacts,
      openDeals: result.openDeals,
    });
    return result;
  }

  /**
   * R14.3 — internal-only "product moat" metric, as ONE combined weekly signal (admin-only):
   * (1) native-linked % — what fraction of CRM records trace back to a Skout-native activation
   * (`sourceProspectId`/`sourceProspectCompanyId`) rather than being created purely by external
   * means (manual entry, HubSpot import), and (2) how much data is *leaving* Skout weekly via
   * HubSpot export (`crm_prospect_mappings`, provider="hubspot") and CSV export
   * (`credit_transactions` action="export_csv"). Both of those tables live in the same shared
   * Postgres @skout/db schema apps/crm already reads other cross-service tables from (e.g.
   * `notifications`) — nothing stops joining them in here, so this combines all three into one
   * DTO instead of leaving it to a separate BI layer.
   */
  async switchingCost(workspaceId: string): Promise<SwitchingCostDto> {
    const sevenDaysAgo = sql`now() - interval '7 days'`;

    const [contactRows, nativeContactRows, companyRows, nativeCompanyRows, hubspotExportRows, csvExportRows] =
      await Promise.all([
        this.db
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.workspaceId, workspaceId), isNull(contacts.deletedAt))),
        this.db
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.workspaceId, workspaceId),
              isNull(contacts.deletedAt),
              sql`${contacts.sourceProspectId} is not null`
            )
          ),
        this.db
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt))),
        this.db
          .select({ id: companies.id })
          .from(companies)
          .where(
            and(
              eq(companies.workspaceId, workspaceId),
              isNull(companies.deletedAt),
              sql`${companies.sourceProspectCompanyId} is not null`
            )
          ),
        this.db
          .select({ prospectId: crmProspectMappings.prospectId })
          .from(crmProspectMappings)
          .where(
            and(
              eq(crmProspectMappings.workspaceId, workspaceId),
              eq(crmProspectMappings.provider, "hubspot"),
              sql`${crmProspectMappings.updatedAt} >= ${sevenDaysAgo}`
            )
          ),
        this.db
          .select({ id: creditTransactions.id })
          .from(creditTransactions)
          .where(
            and(
              eq(creditTransactions.workspaceId, workspaceId),
              eq(creditTransactions.action, "export_csv"),
              sql`${creditTransactions.createdAt} >= ${sevenDaysAgo}`
            )
          ),
      ]);

    const totalContacts = contactRows.length;
    const nativeLinkedContacts = nativeContactRows.length;

    return {
      workspaceId,
      totalContacts,
      nativeLinkedContacts,
      totalCompanies: companyRows.length,
      nativeLinkedCompanies: nativeCompanyRows.length,
      nativeLinkRatePct: totalContacts === 0 ? 0 : Math.round((nativeLinkedContacts / totalContacts) * 1000) / 10,
      hubspotExportVolume7d: hubspotExportRows.length,
      csvExportVolume7d: csvExportRows.length,
      note: "Weekly (trailing 7 days) for the two export-volume fields; native-link rate is a live snapshot, not windowed.",
    };
  }
  /** Open deals untouched for STALE_DEAL_DAYS+ — not role-gated. Unlike switchingCost/croSummary
   *  (org-internal exec metrics), knowing which of the workspace's own deals need attention is
   *  useful to every rep, not just owners/admins. */
  async staleDeals(workspaceId: string): Promise<StaleDealSummary[]> {
    const rows = await this.db
      .select({
        id: deals.id,
        name: deals.name,
        amount: deals.amount,
        currency: deals.currency,
        updatedAt: deals.updatedAt,
      })
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
      .limit(STALE_DEALS_LIMIT);

    const now = Date.now();
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      amount: d.amount === null ? null : Number(d.amount),
      currency: d.currency,
      daysSinceUpdate: Math.floor((now - d.updatedAt.getTime()) / (1000 * 60 * 60 * 24)),
    }));
  }

  /** §8.12 CRM Intelligence pipeline-risk — flags deals where a Decision Maker exists on the
   * deal's account (per Account 360's role classification) but isn't linked to the deal's own
   * buying committee. Read-only join over data Account 360 and BuyingCommitteeService already
   * compute/store; raises no new data collection. Not role-gated, same as staleDeals(). */
  async missingStakeholders(workspaceId: string): Promise<MissingStakeholderFlag[]> {
    const openDeals = await this.db
      .select({ id: deals.id, name: deals.name, companyId: deals.companyId })
      .from(deals)
      .where(and(eq(deals.workspaceId, workspaceId), eq(deals.status, "open"), isNull(deals.deletedAt)))
      .orderBy(deals.updatedAt)
      .limit(MISSING_STAKEHOLDER_DEALS_LIMIT);

    const dealsWithCompany = openDeals.filter(
      (d): d is { id: string; name: string; companyId: string } => d.companyId !== null
    );
    if (dealsWithCompany.length === 0) return [];

    const companyIds = [...new Set(dealsWithCompany.map((d) => d.companyId))];
    const dealIds = dealsWithCompany.map((d) => d.id);

    const [companyContacts, linkedRows] = await Promise.all([
      this.db
        .select({
          id: contacts.id,
          companyId: contacts.companyId,
          title: contacts.title,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, workspaceId),
            isNull(contacts.deletedAt),
            inArray(contacts.companyId, companyIds)
          )
        ),
      this.db
        .select({ dealId: buyingCommittees.dealId, contactId: buyingCommitteeMembers.contactId })
        .from(buyingCommitteeMembers)
        .innerJoin(buyingCommittees, eq(buyingCommittees.id, buyingCommitteeMembers.committeeId))
        .where(and(eq(buyingCommittees.workspaceId, workspaceId), inArray(buyingCommittees.dealId, dealIds))),
    ]);

    const decisionMakersByCompany = new Map<
      string,
      { id: string; title: string | null; firstName: string; lastName: string | null }[]
    >();
    for (const c of companyContacts) {
      if (!c.companyId || classifyAccountRole(c.title) !== DECISION_MAKER_ROLE) continue;
      const list = decisionMakersByCompany.get(c.companyId) ?? [];
      list.push(c);
      decisionMakersByCompany.set(c.companyId, list);
    }

    const linkedContactIdsByDeal = new Map<string, Set<string>>();
    for (const row of linkedRows) {
      if (!row.dealId) continue;
      const set = linkedContactIdsByDeal.get(row.dealId) ?? new Set<string>();
      set.add(row.contactId);
      linkedContactIdsByDeal.set(row.dealId, set);
    }

    const computedAt = new Date().toISOString();
    const flags: MissingStakeholderFlag[] = [];
    for (const deal of dealsWithCompany) {
      const decisionMakers = decisionMakersByCompany.get(deal.companyId) ?? [];
      if (decisionMakers.length === 0) continue;
      const linked = linkedContactIdsByDeal.get(deal.id) ?? new Set<string>();
      for (const contact of decisionMakers) {
        if (linked.has(contact.id)) continue;
        flags.push({
          dealId: deal.id,
          dealName: deal.name,
          companyId: deal.companyId,
          contactId: contact.id,
          contactName: `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "Unknown Contact",
          accountRole: DECISION_MAKER_ROLE,
          rule: MISSING_STAKEHOLDER_RULE,
          computedAt,
        });
      }
    }
    return flags;
  }

  /** GTM revamp — Pipeline Velocity chart data. See DealsService.pipelineVelocity for why this
   * is "new pipeline created per day" rather than a historical open-value snapshot. */
  async pipelineVelocity(workspaceId: string, days = 30): Promise<{ date: string; value: number }[]> {
    return this.dealsService.pipelineVelocity(workspaceId, days);
  }

  /** §SS-10 CRM Intelligence — disengagement risk flags for companies with no recent activity.
   * Not role-gated, same as staleDeals() and missingStakeholders(). */
  async disengagementFlags(workspaceId: string): Promise<DisengagementFlag[]> {
    // Get all active customer companies
    const customerCompanies = await this.db
      .select({
        id: companies.id,
        name: companies.name,
      })
      .from(companies)
      .where(and(eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt)))
      .limit(DISENGAGEMENT_FLAGS_LIMIT);

    if (customerCompanies.length === 0) return [];

    const companyIds = customerCompanies.map(c => c.id);
    
    // Get last activity for each company (activities uses entityId and entityType='company')
    const lastActivities = await this.db
      .select({
        entityId: activities.entityId,
        lastActivityAt: sql<Date>`max(${activities.occurredAt})`
      })
      .from(activities)
      .where(and(
        eq(activities.workspaceId, workspaceId), 
        inArray(activities.entityId, companyIds),
        eq(activities.entityType, 'company')
      ))
      .groupBy(activities.entityId);

    const lastActivityByCompany = new Map<string, Date>();
    for (const row of lastActivities) {
      if (row.entityId) {
        lastActivityByCompany.set(row.entityId, row.lastActivityAt);
      }
    }

    const computedAt = new Date().toISOString();
    const now = Date.now();
    const flags: DisengagementFlag[] = [];

    for (const company of customerCompanies) {
      const lastActivity = lastActivityByCompany.get(company.id);
      const daysSinceActivity = lastActivity 
        ? Math.floor((now - lastActivity.getTime()) / (1000 * 60 * 60 * 24))
        : Infinity;

      if (daysSinceActivity >= DISENGAGEMENT_INACTIVITY_DAYS) {
        flags.push({
          id: `disengagement-${company.id}`,
          companyId: company.id,
          companyName: company.name,
          daysSinceActivity: isFinite(daysSinceActivity) ? daysSinceActivity : 999,
          lastActivityAt: lastActivity?.toISOString() ?? null,
          rule: DISENGAGEMENT_RULE,
          computedAt,
        });
      }
    }

    return flags;
  }

  /** §SS-10 CRM Intelligence — renewal risk flags for deals approaching their contract end date.
   * Not role-gated, same as other CRM Intelligence flags. */
  async renewalRiskFlags(workspaceId: string): Promise<RenewalRiskFlag[]> {
    // Get won deals with contract end dates
    const expiringDeals = await this.db
      .select({
        id: deals.id,
        name: deals.name,
        companyId: deals.companyId,
        contractEndDate: deals.contractEndDate,
        amount: deals.amount,
        currency: deals.currency,
      })
      .from(deals)
      .where(
        and(
          eq(deals.workspaceId, workspaceId),
          eq(deals.status, "won"),
          isNull(deals.deletedAt),
          sql`${deals.contractEndDate} is not null`
        )
      )
      .limit(RENEWAL_RISK_FLAGS_LIMIT);

    if (expiringDeals.length === 0) return [];

    const companyIds = expiringDeals.filter(d => d.companyId).map(d => d.companyId as string);
    const companyList = await this.db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(and(eq(companies.workspaceId, workspaceId), inArray(companies.id, companyIds)));

    const companyMap = new Map<string, string>();
    for (const company of companyList) {
      companyMap.set(company.id, company.name);
    }

    const computedAt = new Date().toISOString();
    const now = Date.now();
    const flags: RenewalRiskFlag[] = [];

    for (const deal of expiringDeals) {
      if (!deal.contractEndDate) continue;
      
      const contractEnd = new Date(deal.contractEndDate);
      const daysUntilExpiry = Math.ceil((contractEnd.getTime() - now) / (1000 * 60 * 60 * 24));

      if (daysUntilExpiry <= RENEWAL_WINDOW_DAYS) {
        flags.push({
          id: `renewal-risk-${deal.id}`,
          dealId: deal.id,
          dealName: deal.name,
          companyId: deal.companyId!,
          companyName: companyMap.get(deal.companyId!) || "Unknown Company",
          contractEndDate: contractEnd.toISOString(),
          daysUntilExpiry,
          rule: RENEWAL_RISK_RULE,
          computedAt,
          amount: deal.amount === null ? null : Number(deal.amount),
          currency: deal.currency,
        });
      }
    }

    return flags;
  }

  /** §SS-10 CRM Intelligence — expansion signal flags for companies showing recent growth signals.
   * Not role-gated, same as other CRM Intelligence flags. */
  async expansionSignalFlags(workspaceId: string): Promise<ExpansionSignalFlag[]> {
    // Get recent expansion signals joined with evidenceLedger for workspace-scoping
    const recentSignals = await this.db
      .select({
        id: signals.id,
        entityId: signals.entityId,
        signalType: signals.signalType,
        detectedAt: signals.detectedAt,
        companyId: companies.id,
        companyName: companies.name,
      })
      .from(signals)
      .leftJoin(evidenceLedger, eq(signals.evidenceId, evidenceLedger.id))
      .leftJoin(companies, and(
        eq(companies.workspaceId, workspaceId),
        eq(companies.id, signals.entityId)
      ))
      .where(
        and(
          eq(evidenceLedger.workspaceId, workspaceId),
          inArray(signals.signalType, Array.from(EXPANSION_SIGNAL_TYPES)),
          sql`${signals.detectedAt} >= now() - interval '${sql.raw(String(EXPANSION_LOOKBACK_DAYS))} days'`
        )
      )
      .limit(EXPANSION_FLAGS_LIMIT);

    if (recentSignals.length === 0) return [];

    const computedAt = new Date().toISOString();
    const flags: ExpansionSignalFlag[] = [];

    for (const signal of recentSignals) {
      flags.push({
        id: `expansion-${signal.id}`,
        companyId: signal.entityId,
        companyName: signal.companyName || "Unknown Company",
        signalType: signal.signalType,
        detectedAt: signal.detectedAt.toISOString(),
        rule: EXPANSION_SIGNAL_RULE,
        computedAt,
      });
    }

    return flags;
  }

  /** R19.1 — admin-gated exec rollup combining overview + switching-cost + real risk-adjacent
   * signals (stale deals, rep activity) that don't require R18 to exist. */
  async croSummary(workspaceId: string): Promise<CroSummaryDto> {
    const [overview, switching, staleDeals, repActivityRows] = await Promise.all([
      this.overview(workspaceId),
      this.switchingCost(workspaceId),
      this.staleDeals(workspaceId),
      this.db
        .select({
          userId: activities.ownerId,
          name: sql<string>`coalesce(${users.fullName}, ${users.email}, 'Unassigned')`,
          activityCount7d: sql<number>`count(*)`,
        })
        .from(activities)
        .leftJoin(users, eq(users.id, activities.ownerId))
        .where(
          and(
            eq(activities.workspaceId, workspaceId),
            sql`${activities.occurredAt} >= now() - interval '7 days'`
          )
        )
        .groupBy(activities.ownerId, users.fullName, users.email)
        .orderBy(desc(sql`count(*)`))
        .limit(10),
    ]);

    const repActivity: RepActivitySummary[] = repActivityRows.map((r) => ({
      userId: r.userId,
      name: r.name,
      activityCount7d: Number(r.activityCount7d),
    }));

    return {
      workspaceId,
      overview,
      switchingCost: switching,
      staleDeals,
      repActivity,
      generatedAt: new Date().toISOString(),
    };
  }
}

export function buildDashboardService(
  db: Db | null,
  dealsService: DealsService | null,
  tasksService: TasksService | null,
  activitiesService: ActivitiesService | null,
  meetingsService: MeetingsService | null
): DashboardService | null {
  return db && dealsService && tasksService && activitiesService
    ? new DashboardService(db, dealsService, tasksService, activitiesService, meetingsService)
    : null;
}