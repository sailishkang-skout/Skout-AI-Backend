import type { FastifyInstance } from "fastify";
import { searchProspectsRequestSchema } from "@skout/shared";
import { searchService } from "../services/search.service.js";

export async function searchRoutes(app: FastifyInstance) {
  app.post("/search/prospects", async (request, reply) => {
    const body = searchProspectsRequestSchema.parse(request.body ?? {});
    const result = await searchService.searchProspects(body);
    return reply.send(result);
  });

  app.get("/search/prospects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await searchService.getProspectById(id);
    return reply.send(result);
  });
}
