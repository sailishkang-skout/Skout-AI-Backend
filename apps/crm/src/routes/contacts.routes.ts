import type { FastifyInstance } from "fastify";

/** Placeholder until native contacts table lands in Phase 2. */
export async function contactsRoutes(app: FastifyInstance) {
  app.get("/contacts", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    return {
      data: [],
      total: 0,
      workspaceId,
      message: "CRM contacts module scaffold — records will appear here after schema migration.",
    };
  });
}
