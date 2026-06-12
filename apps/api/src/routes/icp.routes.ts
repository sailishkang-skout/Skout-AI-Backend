import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getWorkspaceIcp, getWorkspaceIcpVersion, setWorkspaceIcp } from "../services/icp.service.js";

const icpSchema = z.object({
  industries: z.array(z.string()).optional(),
  countries: z.array(z.string()).optional(),
  seniorities: z.array(z.string()).optional(),
  minEmployees: z.number().optional(),
  maxEmployees: z.number().optional(),
});

export async function icpRoutes(app: FastifyInstance) {
  app.get("/workspace/icp", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const config = await getWorkspaceIcp(app.db, workspaceId);
    const version = await getWorkspaceIcpVersion(app.db, workspaceId);
    return reply.send({ workspaceId, config, version: version || undefined });
  });

  app.put("/workspace/icp", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const body = icpSchema.parse(request.body ?? {});
    const row = await setWorkspaceIcp(app.db, workspaceId, body);
    return reply.send({ workspaceId, config: body, version: row?.version ?? 1 });
  });
}
