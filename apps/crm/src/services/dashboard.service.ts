import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { ActivitiesService, ActivityDto } from "./activities.service.js";
import type { CurrencyValue, DealsService } from "./deals.service.js";
import type { TasksService } from "./tasks.service.js";
import type { MeetingsService } from "./meetings.service.js";
import { serviceLog } from "../lib/obs.js";

const log = serviceLog("dashboard");
const { companies, contacts, deals, activities, users, crmProspectMappings, creditTransactions, buyingCommittees, buyingCommitteeMembers } = schema;

export interface DashboardOverviewDto {
  workspaceId: string;
  companies: number;
  contacts: number;
  openDeals: number;
  valueByCurrency: CurrencyValue[];
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

export interface MissingStakeholderEvidence {
  role: string;
  contactId: string;
  contactName: string;
  ruleTriggered: string;
  computedAt: string;
}

export interface MissingStakeholderDealSummary {
  id: string;
  name: string;
  amount: number | null;
  currency: string;
  companyId: string;
  companyName: string;
  evidence: MissingStakeholderEvidence[];
}

export interface RepActivitySummary {
  userId: string | null;
  name: string;
  activityCount7d: number;
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

/**
 * Validates workspace ID format
 * @internal
 */
function validateWorkspaceId(workspaceId: string): void {
  if (!workspaceId || workspaceId.trim().length === 0) {
    throw new Error("Invalid workspace ID: empty or null");
  }
}

export interface DecisionMakerCandidate {
  contactId: string;
  contactName: string;
}

export function findMissingDecisionMakers(
  companyDecisionMakers: DecisionMakerCandidate[],
  dealMemberContactIds: ReadonlySet<string>
): DecisionMakerCandidate[] {
  return companyDecisionMakers.filter((decisionMaker) => !dealMemberContactIds.has(decisionMaker.contactId));
}

export class DashboardService {
  constructor(
    private readonly db: Db,
    private readonly dealsService: DealsService,
    private readonly tasksService: TasksService,
    private readonly activitiesService: ActivitiesService,
    private readonly meetingsService: MeetingsService | null
  ) {}

  /**
   * Gets dashboard overview with key metrics (companies, contacts, deals, tasks, meetings, recent activities).
   * All metrics are workspace-scoped, non-deleted records only.
   *
   * @param workspaceId Workspace identifier
   * @returns Dashboard overview DTO with aggregated metrics
   * @throws {Error} If workspace ID is invalid
   */
  async overview(workspaceId: string): Promise<DashboardOverviewDto> {
    validateWorkspaceId(workspaceId);
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
   * R14.3 — Computes switching cost metrics (native link rate and export volumes).
   * Internal-only "product moat" signal combining:
   * (1) Native-linked % — fraction of CRM records tracing back to Skout activations
   * (2) Data leaving Skout — HubSpot and CSV export volumes (trailing 7 days)
   *
   * @param workspaceId Workspace identifier
   * @returns Switching cost DTO with native link rate and export metrics
   * @throws {Error} If workspace ID is invalid
   */
  async switchingCost(workspaceId: string): Promise<SwitchingCostDto> {
    validateWorkspaceId(workspaceId);
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
  /**
   * Lists open deals untouched for STALE_DEAL_DAYS+ (14 days by default).
   * Non role-gated: all workspace members can see which deals need attention.
   * Results ordered by recency (oldest first), limited to STALE_DEALS_LIMIT.
   *
   * @param workspaceId Workspace identifier
   * @returns Array of stale deal summaries with days since last update
   * @throws {Error} If workspace ID is invalid
   */
  async staleDeals(workspaceId: string): Promise<StaleDealSummary[]> {
    validateWorkspaceId(workspaceId);
    
    try {
      if (!this.db) {
        log.warn("Database not available for stale deals query");
        return [];
      }

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
      const result = rows.map((d) => ({
        id: d.id,
        name: d.name,
        amount: d.amount === null ? null : Number(d.amount),
        currency: d.currency,
        daysSinceUpdate: Math.floor((now - d.updatedAt.getTime()) / (1000 * 60 * 60 * 24)),
      }));
      
      log.debug("stale deals loaded", { workspaceId, count: result.length });
      return result;
    } catch (err) {
      log.error("Error fetching stale deals", { workspaceId, error: String(err) });
      return [];
    }
  }

  /** Deals that have a Decision Maker (economic_buyer) on the account's buying committee
   *  but that contact is not linked to the deal's own buying committee. Follows the same
   *  non-role-gated access pattern as staleDeals — useful to all reps, not just admins.
   *  Optimized to avoid N+1 queries: single bulk queries for all committees/members. */
  async missingStakeholderDeals(workspaceId: string): Promise<MissingStakeholderDealSummary[]> {
    try {
      const computedAt = new Date().toISOString();
      const MISSING_STAKEHOLDERS_LIMIT = 10;

      // Return empty array if database isn't available
      if (!this.db) return [];

      // Step 1: Get all open deals with their company information (single query)
      const openDeals = await this.db
        .select({
          dealId: deals.id,
          dealName: deals.name,
          dealAmount: deals.amount,
          dealCurrency: deals.currency,
          companyId: companies.id,
          companyName: companies.name,
        })
        .from(deals)
        .innerJoin(companies, eq(deals.companyId, companies.id))
        .where(
          and(
            eq(deals.workspaceId, workspaceId),
            eq(deals.status, "open"),
            isNull(deals.deletedAt),
            isNull(companies.deletedAt)
          )
        )
        .limit(MISSING_STAKEHOLDERS_LIMIT);

      if (openDeals.length === 0) return [];

      // Extract all deal IDs and company IDs for bulk queries
      const dealIds = openDeals.map(d => d.dealId);
      const companyIds = openDeals.map(d => d.companyId).filter(Boolean) as string[];
      if (companyIds.length === 0) return [];

      // Step 2: Bulk fetch ALL company buying committees for our open deals' companies (single query)
      const companyCommittees = await this.db
        .select({
          committeeId: buyingCommittees.id,
          companyId: buyingCommittees.companyId,
        })
        .from(buyingCommittees)
        .where(and(
          inArray(buyingCommittees.companyId, companyIds),
          eq(buyingCommittees.workspaceId, workspaceId)
        ));
      const companyCommitteeMap = new Map(companyCommittees.map(c => [c.companyId!, c.committeeId]));

      // Step 3: Bulk fetch ALL deal buying committees for our open deals (single query)
      const validDealIds = dealIds.filter((id): id is string => id !== null);
      const dealCommittees = await this.db
        .select({
          committeeId: buyingCommittees.id,
          dealId: buyingCommittees.dealId,
        })
        .from(buyingCommittees)
        .where(and(
          inArray(buyingCommittees.dealId, validDealIds),
          eq(buyingCommittees.workspaceId, workspaceId)
        ));
      const dealCommitteeMap = new Map(dealCommittees.map(c => [c.dealId!, c.committeeId]));
      const allCommitteeIds = [...new Set([...companyCommittees.map(c => c.committeeId), ...dealCommittees.map(c => c.committeeId)])];

      if (allCommitteeIds.length === 0) return [];

      // Step 4: Bulk fetch ALL committee members for ALL committees (company + deal) (single query)
      const allCommitteeMembers = await this.db
        .select({
          committeeId: buyingCommitteeMembers.committeeId,
          contactId: buyingCommitteeMembers.contactId,
          role: buyingCommitteeMembers.role,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
        })
        .from(buyingCommitteeMembers)
        .innerJoin(contacts, eq(contacts.id, buyingCommitteeMembers.contactId))
        .where(and(
          inArray(buyingCommitteeMembers.committeeId, allCommitteeIds),
          isNull(contacts.deletedAt)
        ));

      // Build maps for company decision makers and deal members
      const companyDecisionMakersByCompany = new Map<string, Array<{contactId: string; contactName: string}>>();
      const dealMembersByDeal = new Map<string, Set<string>>();

      // Populate maps from bulk member data
      for (const member of allCommitteeMembers) {
        // Check if this is a company committee member (economic buyer)
        const companyEntry = companyCommittees.find(c => c.committeeId === member.committeeId);
        if (companyEntry && member.role === "economic_buyer") {
          const existing = companyDecisionMakersByCompany.get(companyEntry.companyId!) || [];
          existing.push({
            contactId: member.contactId,
            contactName: `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim() || "Unknown Contact"
          });
          companyDecisionMakersByCompany.set(companyEntry.companyId!, existing);
        }
        // Check if this is a deal committee member
        const dealEntry = dealCommittees.find(c => c.committeeId === member.committeeId);
        if (dealEntry?.dealId) {
          const existing = dealMembersByDeal.get(dealEntry.dealId) || new Set();
          existing.add(member.contactId);
          dealMembersByDeal.set(dealEntry.dealId, existing);
        }
      }

      // Step 5: Process all deals with pre-fetched data (no more DB calls!)
      const result: MissingStakeholderDealSummary[] = [];
      for (const deal of openDeals) {
        if (!deal.companyId) continue;
        
        const companyDecisionMakers = companyDecisionMakersByCompany.get(deal.companyId) || [];
        if (companyDecisionMakers.length === 0) continue;

        const dealMemberContactIds = dealMembersByDeal.get(deal.dealId) || new Set();
        const missingDecisionMakers = findMissingDecisionMakers(companyDecisionMakers, dealMemberContactIds);

        if (missingDecisionMakers.length > 0) {
          const evidence: MissingStakeholderEvidence[] = missingDecisionMakers.map(dm => ({
            role: "Decision Maker",
            contactId: dm.contactId,
            contactName: dm.contactName,
            ruleTriggered: "missing_account_decision_maker",
            computedAt,
          }));

          result.push({
            id: deal.dealId,
            name: deal.dealName,
            amount: deal.dealAmount === null ? null : Number(deal.dealAmount),
            currency: deal.dealCurrency,
            companyId: deal.companyId,
            companyName: deal.companyName,
            evidence,
          });
        }
      }

      return result;
    } catch (err) {
      console.error("Error fetching missing stakeholder deals:", err);
      return [];
    }
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