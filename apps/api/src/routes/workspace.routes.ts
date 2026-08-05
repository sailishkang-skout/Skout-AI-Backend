import type { FastifyInstance } from "fastify";
import { workspaceService } from "../services/workspace.service.js";

export async function workspaceRoutes(app: FastifyInstance) {
  app.get("/workspaces", async (_request, reply) => {
    const workspaces = await workspaceService.listWorkspaces();
    return reply.send({ data: workspaces });
  });

  app.get("/workspaces/current", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "00000000-0000-4000-8000-000000000001";
    const current = await workspaceService.getCurrent(workspaceId);
    return reply.send({ data: current });
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

  app.get("/me", async (_request, reply) => {
    // Stub/dev role hint: the CRM detail pages gate the audit-log UI behind
    // owner/admin, so return an owner role here so the feature renders in local
    // verification. The real /me route resolves from workspace_members.
    return reply.send({ id: "u-owner", email: "stub@example.com", role: "owner" });
  });

  app.get("/workspace/icp", async (_request, reply) => {
    const icp = await workspaceService.getWorkspaceIcp();
    return reply.send(icp);
  });

  app.put("/workspace/icp", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const saved = await workspaceService.getWorkspaceIcp();
    return reply.send({
      ...saved,
      config: body as typeof saved.config,
      version: (saved.version ?? 1) + 1,
    });
  });
}
