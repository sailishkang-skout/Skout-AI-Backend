import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorResponse } from "../utils/http.js";
import { buildIncidentsService } from "../services/incidents.service.js";

const createSchema = z.object({
  title: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  source: z.string().min(1),
  description: z.string().optional(),
  relatedEntityType: z.string().optional(),
  relatedEntityId: z.string().optional(),
});

const listQuerySchema = z.object({
  status: z.enum(["open", "investigating", "resolved"]).optional(),
});

const resolveSchema = z.object({
  resolutionNotes: z.string().optional(),
});

/**
 * §5.1 / §11.3 Task 36 (Enterprise Completion Plan) — Incident endpoints. Create/list/get/
 * acknowledge open to any authenticated workspace member (an alerting integration or any team
 * member should be able to log or triage an incident); resolve() requires owner/admin, matching
 * the role bar this codebase uses for other actions that close out a consequential state change
 * (see team.routes.ts, retention-rules.routes.ts).
 */
export async function incidentsRoutes(app: FastifyInstance) {
  const service = () => buildIncidentsService(app.db ?? null);

  app.post("/incidents", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));

    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid incident payload", 400, parsed.error.flatten()));
    }

    const incident = await svc.create({ workspaceId: request.workspaceId, ...parsed.data });
    return reply.code(201).send({ data: incident });
  });

  app.get("/incidents", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.send({ data: [] });

    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid query", 400, parsed.error.flatten()));
    }

    const data = await svc.list(request.workspaceId, parsed.data.status);
    return reply.send({ data });
  });

  app.get<{ Params: { id: string } }>("/incidents/:id", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));

    const incident = await svc.get(request.workspaceId, request.params.id);
    if (!incident) return reply.code(404).send(errorResponse("incident_not_found", 404));
    return reply.send({ data: incident });
  });

  app.post<{ Params: { id: string } }>("/incidents/:id/acknowledge", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));

    const incident = await svc.acknowledge(request.workspaceId, request.params.id);
    return reply.send({ data: incident });
  });

  app.post<{ Params: { id: string } }>("/incidents/:id/resolve", async (request, reply) => {
    if (!request.workspaceId || !request.role) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!["owner", "admin"].includes(request.role)) {
      return reply.code(403).send(errorResponse("Requires role: owner or admin", 403));
    }
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));

    const parsed = resolveSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid resolve payload", 400, parsed.error.flatten()));
    }

    const incident = await svc.resolve(request.workspaceId, request.params.id, request.userId, parsed.data.resolutionNotes);
    return reply.send({ data: incident });
  });
}
