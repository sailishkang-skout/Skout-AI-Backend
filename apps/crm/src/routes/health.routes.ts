import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    status: "ok",
    service: "skout-crm",
    timestamp: new Date().toISOString(),
  }));
}
