import type { FastifyInstance } from "fastify";
import { searchProspectsRequestSchema } from "@skout/shared";
import { createSearchService } from "../services/search.service.js";

export async function searchRoutes(app: FastifyInstance) {
  app.post("/search/prospects", async (request, reply) => {
    app.log.info({ rawBody: request.body }, "search request received");
    const body = searchProspectsRequestSchema.parse(request.body ?? {});
    app.log.info({ parsedFilters: body.filters, query: body.query }, "search parsed");
    const svc = createSearchService(app.config);
    const result = await svc.searchProspects(body);
    return reply.send(result);
  });

  app.get("/search/prospects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const svc = createSearchService(app.config);
    const result = await svc.getProspectById(id);
    return reply.send(result);
  });
}
