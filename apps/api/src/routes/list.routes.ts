import type { FastifyInstance } from "fastify";
import { createListSchema } from "@skout/shared";
import { listService } from "../services/list.service.js";

export async function listRoutes(app: FastifyInstance) {
  app.get("/lists", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    return reply.send(await listService.list(workspaceId));
  });

  app.post("/lists", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const body = createListSchema.parse(request.body ?? {});
    const list = await listService.create(workspaceId, body.name, body.prospectIds);
    return reply.status(201).send(list);
  });
}
