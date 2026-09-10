import type { FastifyInstance } from "fastify";
import { errorResponse } from "../utils/http.js";
import { buildModelVersionsService } from "../services/model-versions.service.js";

/**
 * §5.1 Task 36 (Enterprise Completion Plan) — read-only HTTP surface for ModelVersion/
 * PromptVersion. Deliberately GET-only: see model-versions.service.ts's doc comment for why
 * writes to these platform-wide (non workspace-scoped) tables are not exposed through the
 * ordinary workspace-authenticated API in this pass. Reads are still gated behind
 * authentication (any workspace member) rather than left fully public, since prompt content
 * (packages/db/src/schema/model-versions.ts's `promptVersions.content`) is internal
 * operational detail, not something to serve to anonymous callers.
 */
export async function modelVersionsRoutes(app: FastifyInstance) {
  const service = () => buildModelVersionsService(app.db ?? null);

  app.get<{ Querystring: { name?: string } }>("/model-versions", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.send({ data: [] });

    const data = await svc.listModelVersions(request.query?.name);
    return reply.send({ data });
  });

  app.get<{ Querystring: { name: string } }>("/model-versions/active", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.send({ data: null });

    if (!request.query?.name) {
      return reply.status(400).send(errorResponse("name query parameter is required", 400));
    }

    const data = await svc.getActiveModelVersion(request.query.name);
    return reply.send({ data });
  });

  app.get<{ Querystring: { name: string } }>("/prompt-versions", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.send({ data: [] });

    if (!request.query?.name) {
      return reply.status(400).send(errorResponse("name query parameter is required", 400));
    }

    const data = await svc.listPromptVersions(request.query.name);
    return reply.send({ data });
  });

  app.get<{ Querystring: { name: string } }>("/prompt-versions/active", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.send({ data: null });

    if (!request.query?.name) {
      return reply.status(400).send(errorResponse("name query parameter is required", 400));
    }

    const data = await svc.getActivePromptVersion(request.query.name);
    return reply.send({ data });
  });
}
