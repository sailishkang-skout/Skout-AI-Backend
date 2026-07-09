import type { FastifyInstance } from "fastify";

/** Placeholder until native companies table lands in Phase 2. */
export async function companiesRoutes(app: FastifyInstance) {
  app.get("/companies", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    return {
      data: [],
      total: 0,
      workspaceId,
      message: "CRM companies module scaffold — records will appear here after schema migration.",
    };
  });

  app.get("/companies/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.status(404).send({
      error: "company_not_found",
      message: `Company ${id} not found`,
      statusCode: 404,
    });
  });
}
