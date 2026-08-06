import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TASK_STATUSES, updateTaskStatus } from "../services/task.service.js";
import { errorResponse } from "../utils/http.js";

const statusBodySchema = z.object({
  status: z.enum(TASK_STATUSES),
});

/** Minimal task status transition (R17.2) — see task.service.ts for scope notes. */
export async function taskRoutes(app: FastifyInstance) {
  app.patch("/crm/tasks/:id/status", async (request, reply) => {
    const workspaceId = request.workspaceId;
    if (!workspaceId) return reply.status(401).send(errorResponse("Not authenticated", 401));
    if (!app.db) return reply.status(503).send(errorResponse("Database unavailable", 503));

    const { id } = request.params as { id: string };
    const { status } = statusBodySchema.parse(request.body ?? {});

    const updated = await updateTaskStatus(app.db, workspaceId, id, status);
    if (!updated) return reply.status(404).send(errorResponse("task_not_found", 404));
    return reply.send(updated);
  });
}
