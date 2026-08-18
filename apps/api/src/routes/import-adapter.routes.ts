import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { commitProviderImport, IMPORT_PROVIDERS, listProviderContacts, listProviderLists } from "../services/import-adapters/pipeline.service.js";
import { errorResponse, HttpError } from "../utils/http.js";

const providerParamSchema = z.object({ provider: z.enum(IMPORT_PROVIDERS) });

const commitSchema = z.object({
  listId: z.string().uuid().optional(),
  newListName: z.string().min(1).max(255).optional(),
  sourceListId: z.string().optional(),
  maxContacts: z.number().int().positive().max(500).optional(),
});

/**
 * R22.2 — generic GTM-provider import: same three endpoints regardless of provider
 * (`hubspot` | `apollo` today; a third provider only needs a new adapter + registry entry).
 */
export async function importAdapterRoutes(app: FastifyInstance) {
  app.get("/import/:provider/lists", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { provider } = providerParamSchema.parse(request.params);
    try {
      const data = await listProviderLists(app.db, app.config, provider, request.workspaceId);
      return reply.send({ data });
    } catch (err) {
      if (err instanceof HttpError) return reply.code(err.statusCode).send(errorResponse(err.message, err.statusCode));
      throw err;
    }
  });

  app.get("/import/:provider/contacts", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { provider } = providerParamSchema.parse(request.params);
    const { listId, maxContacts } = request.query as { listId?: string; maxContacts?: string };
    try {
      const data = await listProviderContacts(
        app.db,
        app.config,
        provider,
        request.workspaceId,
        listId,
        maxContacts ? Number(maxContacts) : undefined
      );
      return reply.send({ data, total: data.length });
    } catch (err) {
      if (err instanceof HttpError) return reply.code(err.statusCode).send(errorResponse(err.message, err.statusCode));
      throw err;
    }
  });

  app.post("/import/:provider/commit", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { provider } = providerParamSchema.parse(request.params);
    const input = commitSchema.parse(request.body ?? {});
    try {
      const result = await commitProviderImport(app.db, app.config, provider, request.workspaceId, input);
      return reply.code(201).send({ data: result });
    } catch (err) {
      if (err instanceof HttpError) return reply.code(err.statusCode).send(errorResponse(err.message, err.statusCode));
      throw err;
    }
  });
}
