import type { FastifyInstance } from "fastify";
import { pipelineCreateSchema, pipelineStageCreateSchema } from "@skout/shared";
import { HttpError } from "@skout/auth";
import { parseIdParam } from "../utils/http.js";
import { buildPipelinesService } from "../services/pipelines.service.js";

export async function pipelinesRoutes(app: FastifyInstance) {
  const service = () => buildPipelinesService(app.db ?? null);

  app.get("/pipelines", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) return { data: [], total: 0, workspaceId };

    const data = await svc.list(workspaceId);
    return { data, total: data.length, workspaceId };
  });

  app.post("/pipelines", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = pipelineCreateSchema.parse(request.body);
    const pipeline = await svc.create(workspaceId, input);
    return reply.code(201).send(pipeline);
  });

  app.post("/pipelines/:id/stages", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = pipelineStageCreateSchema.parse(request.body);
    const stage = await svc.addStage(workspaceId, id, input);
    return reply.code(201).send(stage);
  });
}
