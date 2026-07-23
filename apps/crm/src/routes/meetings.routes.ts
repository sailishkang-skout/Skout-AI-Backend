import type { FastifyInstance } from "fastify";
import { meetingCreateSchema, meetingListQuerySchema, meetingUpdateSchema } from "@skout/shared";
import { HttpError } from "@skout/auth";
import { parseIdParam } from "../utils/http.js";
import { requireRole } from "../utils/require-role.js";
import { buildActivitiesService } from "../services/activities.service.js";
import { buildMeetingsService } from "../services/meetings.service.js";

export async function meetingsRoutes(app: FastifyInstance) {
  const service = () => {
    const db = app.db ?? null;
    const activitiesService = buildActivitiesService(db);
    return buildMeetingsService(db, activitiesService);
  };

  app.get("/meetings", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const query = meetingListQuerySchema.parse(request.query);
    const result = await svc.list(workspaceId, query);
    return { ...result, workspaceId };
  });

  app.post("/meetings", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = meetingCreateSchema.parse(request.body);
    const meeting = await svc.create(workspaceId, request.userId, input);
    return reply.code(201).send(meeting);
  });

  app.get("/meetings/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const meeting = await svc.getById(workspaceId, id);
    if (!meeting) throw new HttpError("meeting_not_found", 404);
    return reply.send(meeting);
  });

  app.patch("/meetings/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = meetingUpdateSchema.parse(request.body);
    const meeting = await svc.update(workspaceId, id, input);
    if (!meeting) throw new HttpError("meeting_not_found", 404);
    return reply.send(meeting);
  });

  app.delete("/meetings/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    requireRole(request, ["owner", "admin"]);
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const deleted = await svc.softDelete(workspaceId, id);
    if (!deleted) throw new HttpError("meeting_not_found", 404);
    return reply.code(204).send();
  });
}
