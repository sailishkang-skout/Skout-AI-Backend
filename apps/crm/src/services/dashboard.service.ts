import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { ActivitiesService, ActivityDto } from "./activities.service.js";
import type { DealsService } from "./deals.service.js";
import type { TasksService } from "./tasks.service.js";
import type { MeetingsService } from "./meetings.service.js";
import { serviceLog } from "../lib/obs.js";

const log = serviceLog("dashboard");
const { companies, contacts, deals, activities, users } = schema;

export interface DashboardOverviewDto {
  workspaceId: string;
  companies: number;
  contacts: number;
  openDeals: number;
  pipelineValue: number;
  currency: string;
  openTasks: number;
  overdueTasks: number;
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
      pipelineValue: dealsSummary.pipelineValue,
      currency: dealsSummary.currency,
      openTasks: taskCounts.open,
      overdueTasks: taskCounts.overdue,
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
   * R14.3 — internal-only "product moat" metric: what fraction of CRM records trace back
   * to a Skout-native activation (`sourceProspectId`/`sourceProspectCompanyId`) rather than
   * being created purely by external means (manual entry, HubSpot import). This is one half
   * of the switching-cost signal from docs/tickets/phase-1-feature-work-plan.md R14.3 — the
   * other half (HubSpot export volume, CSV export volume) lives in apps/api's
   * crm_prospect_mappings / list-export tables and isn't joinable from this service's DB
   * connection; combine the two in a BI/analytics layer, not here.
   */
  async switchingCost(workspaceId: string): Promise<SwitchingCostDto> {
    const [contactRows, nativeContactRows, companyRows, nativeCompanyRows] = await Promise.all([
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
      note:
        "Contact-linkage half of the metric only. HubSpot/CSV export volume must be joined in from apps/api separately — see R14.3 in phase-1-feature-work-plan.md.",
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
