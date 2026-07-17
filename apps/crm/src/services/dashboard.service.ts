import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { ActivitiesService, ActivityDto } from "./activities.service.js";
import type { DealsService } from "./deals.service.js";
import type { TasksService } from "./tasks.service.js";
import type { MeetingsService } from "./meetings.service.js";

const { companies, contacts } = schema;

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

    return {
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
