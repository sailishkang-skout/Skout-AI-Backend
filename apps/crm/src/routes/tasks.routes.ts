import type { FastifyInstance } from "fastify";
import { taskCreateSchema, taskListQuerySchema, taskUpdateSchema } from "@skout/shared";
import { HttpError } from "@skout/auth";
import { parseIdParam } from "../utils/http.js";
import { requireRole } from "../utils/require-role.js";
import { buildTasksService } from "../services/tasks.service.js";

export async function tasksRoutes(app: FastifyInstance) {
  const service = () => buildTasksService(app.db ?? null);

  app.get("/tasks", async (request) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const query = taskListQuerySchema.parse(request.query);
    const result = await svc.list(workspaceId, query);
    return { ...result, workspaceId };
  });

  app.post("/tasks", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = taskCreateSchema.parse(request.body);
    const task = await svc.create(workspaceId, request.userId, input);
    return reply.code(201).send(task);
  });

  app.patch("/tasks/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const input = taskUpdateSchema.parse(request.body);
    const task = await svc.update(workspaceId, id, input);
    if (!task) throw new HttpError("task_not_found", 404);
    return reply.send(task);
  });

  app.post("/tasks/:id/complete", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const task = await svc.complete(workspaceId, id);
    if (!task) throw new HttpError("task_not_found", 404);
    return reply.send(task);
  });

  app.delete("/tasks/:id", async (request, reply) => {
    const id = parseIdParam(request);
    const workspaceId = request.workspaceId ?? "unknown";
    requireRole(request, ["owner", "admin"]);
    const svc = service();
    if (!svc) throw new HttpError("database_unavailable", 503);

    const deleted = await svc.softDelete(workspaceId, id);
    if (!deleted) throw new HttpError("task_not_found", 404);
    return reply.code(204).send();
  });
}
