import type { FastifyInstance } from "fastify";
import { companiesRoutes } from "./companies.routes.js";
import { contactsRoutes } from "./contacts.routes.js";
import { dealsRoutes } from "./deals.routes.js";
import { healthRoutes } from "./health.routes.js";

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes, { prefix: "/api/v1/crm" });

  await app.register(async (v1) => {
    await v1.register(companiesRoutes);
    await v1.register(contactsRoutes);
    await v1.register(dealsRoutes);
  }, { prefix: "/api/v1" });
}
