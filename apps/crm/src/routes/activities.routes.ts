import type { FastifyInstance } from "fastify";
import { activityCreateSchema, activityListQuerySchema } from "@skout/shared";
import { HttpError } from "@skout/auth";
import { buildActivitiesService } from "../services/activities.service.js";

export async function activitiesRoutes(app: FastifyInstance) {
  const service = () => buildActivitiesService(app.db ?? null);

  app.get("/activities", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const { entityType, entityId, limit, offset } = activityListQuerySchema.parse(request.query);
    const result = await svc.list(workspaceId, entityType, entityId, { limit, offset });
    return { ...result, workspaceId };
  });

  app.post("/activities", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = activityCreateSchema.parse(request.body);
    const activity = await svc.create(workspaceId, request.userId, input);
    return reply.code(201).send(activity);
  });
}
