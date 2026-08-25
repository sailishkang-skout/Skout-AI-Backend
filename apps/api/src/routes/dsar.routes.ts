import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorResponse } from "../utils/http.js";
import { buildDsarService } from "../services/dsar.service.js";
import { HttpError } from "@skout/auth";

const createSchema = z.object({
  requestType: z.enum(["access", "erasure", "rectification", "portability"]),
  subjectEmail: z.string().email(),
  subjectType: z.string().optional(),
  subjectId: z.string().optional(),
  notes: z.string().optional(),
  /** manual = legal/ops SLA queue; auto = access/portability JSON export now */
  fulfillmentMode: z.enum(["manual", "auto"]).optional(),
});

const statusSchema = z.object({
  status: z.enum(["received", "in_progress", "completed", "rejected"]),
  notes: z.string().optional(),
});

/** §16 — Data Subject Access Request intake + status. */
export async function dsarRoutes(app: FastifyInstance) {
  const service = () => buildDsarService(app.db ?? null);

  app.post("/dsar", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));

    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid DSAR payload", 400, parsed.error.flatten()));
    }

    const row = await svc.create(request.workspaceId, {
      ...parsed.data,
      requestedBy: request.userId,
    });
    return reply.code(201).send({ data: row });
  });

  app.get("/dsar", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const q = z.object({ status: z.string().optional() }).safeParse(request.query ?? {});
    const data = await svc.list(request.workspaceId, q.success ? q.data.status : undefined);
    return reply.send({ data, total: data.length });
  });

  app.patch("/dsar/:id", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const parsed = statusSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid status payload", 400, parsed.error.flatten()));
    }
    try {
      const row = await svc.updateStatus(request.workspaceId, id, parsed.data.status, parsed.data.notes);
      return reply.send({ data: row });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      throw err;
    }
  });
}
