import type { FastifyInstance } from "fastify";
import { aiRoutes } from "./ai.routes.js";
import { crmRoutes, webhookRoutes } from "./crm.routes.js";
import { healthRoutes } from "./health.routes.js";
import { inboxRoutes } from "./inbox.routes.js";
import { listRoutes } from "./list.routes.js";
import { prospectRoutes } from "./prospect.routes.js";
import { searchRoutes } from "./search.routes.js";
import { sequenceRoutes } from "./sequence.routes.js";
import { workspaceRoutes } from "./workspace.routes.js";
import { userRoutes } from "./user.routes.js";

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes, { prefix: "/api/v1" });

  await app.register(async (v1) => {
    await v1.register(userRoutes);
    await v1.register(workspaceRoutes);
    await v1.register(searchRoutes);
    await v1.register(prospectRoutes);
    await v1.register(listRoutes);
    await v1.register(sequenceRoutes);
    await v1.register(inboxRoutes);
    await v1.register(aiRoutes);
    await v1.register(crmRoutes);
    await v1.register(webhookRoutes);
  }, { prefix: "/api/v1" });
}
