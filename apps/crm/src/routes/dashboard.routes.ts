import type { FastifyInstance } from "fastify";
import { buildActivitiesService } from "../services/activities.service.js";
import { buildAuditService } from "../services/audit.service.js";
import { buildCompaniesService } from "../services/companies.service.js";
import { buildDashboardService } from "../services/dashboard.service.js";
import { buildDealsService } from "../services/deals.service.js";
import { buildMeetingsService } from "../services/meetings.service.js";
import { buildPipelinesService } from "../services/pipelines.service.js";
import { buildTasksService } from "../services/tasks.service.js";

export async function dashboardRoutes(app: FastifyInstance) {
  const service = () => {
    const db = app.db ?? null;
    const auditService = buildAuditService(db);
    const companiesService = buildCompaniesService(db, auditService);
    const pipelinesService = buildPipelinesService(db, auditService);
    const activitiesService = buildActivitiesService(db);
    const dealsService = buildDealsService(db, companiesService, pipelinesService, activitiesService, auditService);
    const tasksService = buildTasksService(db, auditService, app.config?.REMINDER_LEAD_HOURS ?? 24);
    const meetingsService = buildMeetingsService(db, activitiesService);
    return buildDashboardService(db, dealsService, tasksService, activitiesService, meetingsService);
  };

  app.get("/dashboard/overview", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) {
      return {
        workspaceId,
        companies: 0,
        contacts: 0,
        openDeals: 0,
        pipelineValue: 0,
        currency: "USD",
        openTasks: 0,
        overdueTasks: 0,
        dueTodayTasks: 0,
        upcomingMeetings: 0,
        recentActivities: [],
      };
    }
    return svc.overview(workspaceId);
  });
}
