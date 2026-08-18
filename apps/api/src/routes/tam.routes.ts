import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createTam, drillIntoTamSegment, getTam, listTams, recomputeTam } from "../services/tam.service.js";
import { errorResponse, HttpError } from "../utils/http.js";

const filterConfigSchema = z.object({
  industries: z.array(z.string()).optional(),
  countries: z.array(z.string()).optional(),
  seniorities: z.array(z.string()).optional(),
  minEmployees: z.number().int().min(0).optional(),
  maxEmployees: z.number().int().min(0).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(255),
  filterConfig: filterConfigSchema.optional(),
});

const drillInSchema = z.object({
  name: z.string().min(1).max(255),
  dimension: z.enum(["industry", "size", "geo"]).optional(),
  value: z.string().optional(),
});

/** R12.1/R12.2/R12.3 — TAM: named, re-computable account universe from the workspace ICP. */
export async function tamRoutes(app: FastifyInstance) {
  app.get("/tam", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const data = await listTams(app.db, request.workspaceId);
    return reply.send({ data });
  });

  app.post("/tam", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const input = createSchema.parse(request.body ?? {});
    try {
      const tam = await createTam(app.db, app.config, request.workspaceId, input, request.userId);
      return reply.code(201).send({ data: tam });
    } catch (err) {
      if (err instanceof HttpError) return reply.code(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      throw err;
    }
  });

  app.get("/tam/:id", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = request.params as { id: string };
    const tam = await getTam(app.db, request.workspaceId, id);
    if (!tam) return reply.code(404).send(errorResponse("TAM not found", 404));
    return reply.send({ data: tam });
  });

  app.post("/tam/:id/recompute", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = request.params as { id: string };
    try {
      const tam = await recomputeTam(app.db, app.config, request.workspaceId, id);
      return reply.send({ data: tam });
    } catch (err) {
      if (err instanceof HttpError) return reply.code(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      throw err;
    }
  });

  // Drill a segment (or the whole TAM) into a live smart list — reuses the existing smart-list
  // run/export/push-to-sequence pipeline instead of a bespoke TAM-only path.
  app.post("/tam/:id/segments/drill-in", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = request.params as { id: string };
    const input = drillInSchema.parse(request.body ?? {});
    try {
      const smartList = await drillIntoTamSegment(app.db, request.workspaceId, id, input);
      return reply.code(201).send({ data: smartList });
    } catch (err) {
      if (err instanceof HttpError) return reply.code(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      throw err;
    }
  });
}
