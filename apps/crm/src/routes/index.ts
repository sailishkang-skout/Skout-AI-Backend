import type { FastifyInstance } from "fastify";
import { activitiesRoutes } from "./activities.routes.js";
import { companiesRoutes } from "./companies.routes.js";
import { contactsRoutes } from "./contacts.routes.js";
import { dashboardRoutes } from "./dashboard.routes.js";
import { dealsRoutes } from "./deals.routes.js";
import { healthRoutes } from "./health.routes.js";
import { meetingsRoutes } from "./meetings.routes.js";
import { pipelinesRoutes } from "./pipelines.routes.js";
import { tasksRoutes } from "./tasks.routes.js";

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes, { prefix: "/api/v1/crm" });

  await app.register(async (v1) => {
    await v1.register(companiesRoutes);
    await v1.register(contactsRoutes);
    await v1.register(dealsRoutes);
    await v1.register(pipelinesRoutes);
    await v1.register(tasksRoutes);
    await v1.register(activitiesRoutes);
    await v1.register(meetingsRoutes);
    await v1.register(dashboardRoutes);
  }, { prefix: "/api/v1" });
}
