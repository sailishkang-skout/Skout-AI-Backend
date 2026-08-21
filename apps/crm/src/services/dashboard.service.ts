import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { ActivitiesService, ActivityDto } from "./activities.service.js";
import type { CurrencyValue, DealsService } from "./deals.service.js";
import type { TasksService } from "./tasks.service.js";
import type { MeetingsService } from "./meetings.service.js";
import { serviceLog } from "../lib/obs.js";

const log = serviceLog("dashboard");
const { companies, contacts, deals, activities, users, crmProspectMappings, creditTransactions } = schema;

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
  /** R19.1 — admin-gated exec rollup combining overview + switching-cost + real risk-adjacent
   * signals (stale deals, rep activity) that don't require R18 to exist. */
  async croSummary(workspaceId: string): Promise<CroSummaryDto> {
    const [overview, switching, staleDealRows, repActivityRows] = await Promise.all([
      this.overview(workspaceId),
      this.switchingCost(workspaceId),
      this.db
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
        .limit(STALE_DEALS_LIMIT),
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

    const now = Date.now();
    const staleDeals: StaleDealSummary[] = staleDealRows.map((d) => ({
      id: d.id,
      name: d.name,
      amount: d.amount === null ? null : Number(d.amount),
      currency: d.currency,
      daysSinceUpdate: Math.floor((now - d.updatedAt.getTime()) / (1000 * 60 * 60 * 24)),
    }));

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
