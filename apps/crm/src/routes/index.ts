import type { FastifyInstance } from "fastify";
import { activitiesRoutes } from "./activities.routes.js";
import { auditRoutes } from "./audit.routes.js";
import { buyingCommitteeRoutes } from "./buying-committee.routes.js";
import { companiesRoutes } from "./companies.routes.js";
import { contactsRoutes } from "./contacts.routes.js";
import { dashboardRoutes } from "./dashboard.routes.js";
import { dealsRoutes } from "./deals.routes.js";
import { healthRoutes } from "./health.routes.js";
import { meetingsRoutes } from "./meetings.routes.js";
import { meetingRsvpWebhookRoutes } from "./meeting-rsvp-webhook.routes.js";
import { pipelinesRoutes } from "./pipelines.routes.js";
import { promotionRoutes } from "./promotion.routes.js";
import { retentionRulesRoutes } from "./retention-rules.routes.js";
import { tasksRoutes } from "./tasks.routes.js";
import { internalCrmRoutes } from "./internal.routes.js";

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes, { prefix: "/api/v1/crm" });

  // §5 / §7.1 — service-to-service API (token auth; no Clerk)
  await app.register(internalCrmRoutes, { prefix: "/internal/v1" });

  await app.register(async (v1) => {
    await v1.register(companiesRoutes);
    await v1.register(contactsRoutes);
    await v1.register(dealsRoutes);
    await v1.register(pipelinesRoutes);
    await v1.register(tasksRoutes);
    await v1.register(activitiesRoutes);
    await v1.register(auditRoutes);
    await v1.register(meetingsRoutes);
    await v1.register(meetingRsvpWebhookRoutes);
    await v1.register(promotionRoutes);
    await v1.register(dashboardRoutes);
    await v1.register(buyingCommitteeRoutes);
    await v1.register(retentionRulesRoutes);
  }, { prefix: "/api/v1" });
}
