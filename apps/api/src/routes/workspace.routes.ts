import type { FastifyInstance } from "fastify";
import { workspaceService } from "../services/workspace.service.js";

export async function workspaceRoutes(app: FastifyInstance) {
  app.get("/workspaces", async (_request, reply) => {
    const workspaces = await workspaceService.listWorkspaces();
    return reply.send({ data: workspaces });
  });

  app.get("/workspaces/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaces = await workspaceService.listWorkspaces();
    const workspace = workspaces.find((w) => w.id === id);
    if (!workspace) {
      return reply.status(404).send({ error: "Workspace not found" });
    }
    return reply.send(workspace);
  });
}
