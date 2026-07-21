import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getWorkspaceIcp,
  getWorkspaceIcpVersion,
  isIcpConfigured,
  setWorkspaceIcp,
} from "../services/icp.service.js";
import { startWorkspaceRescoreIfEnabled } from "../services/workspace-rescore.service.js";

const icpSchema = z.object({
  industries: z.array(z.string()).optional(),
  countries: z.array(z.string()).optional(),
  seniorities: z.array(z.string()).optional(),
  titles: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  minEmployees: z.number().optional(),
  maxEmployees: z.number().optional(),
  companyName: z.string().max(200).optional(),
  productDescription: z.string().max(2000).optional(),
  customerPainPoints: z.array(z.string()).optional(),
  autoRescoreOnChange: z.boolean().optional(),
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
    const previousVersion = await getWorkspaceIcpVersion(app.db, workspaceId);
    const row = await setWorkspaceIcp(app.db, workspaceId, body);
    const version = row?.version ?? 1;

    let rescoreJob = null;
    if (isIcpConfigured(body) && version > previousVersion) {
      try {
        rescoreJob = await startWorkspaceRescoreIfEnabled(
          app.db,
          app.config,
          workspaceId,
          body,
          version,
          previousVersion
        );
      } catch (err) {
        request.log.warn({ err, workspaceId }, "ICP rescore enqueue failed");
      }
    }

    return reply.send({
      workspaceId,
      config: body,
      version,
      rescoreJob,
    });
  });
}
