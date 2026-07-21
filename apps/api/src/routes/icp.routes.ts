import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getWorkspaceIcp,
  getWorkspaceIcpVersion,
  isIcpConfigured,
  setWorkspaceIcp,
} from "../services/icp.service.js";
import { startWorkspaceRescoreIfEnabled } from "../services/workspace-rescore.service.js";

const onboardingSchema = z.object({
  company: z
    .object({
      name: z.string().max(200).optional(),
      industry: z.string().max(100).optional(),
      size: z.string().max(50).optional(),
      website: z.string().max(300).optional(),
    })
    .optional(),
  goals: z.array(z.string().max(100)).max(20).optional(),
  icp: z
    .object({
      industries: z.array(z.string().max(100)).max(50).optional(),
      employeeRanges: z.array(z.string().max(50)).max(20).optional(),
      countries: z.array(z.string().max(100)).max(50).optional(),
      revenue: z.string().max(50).optional(),
    })
    .optional(),
  people: z
    .object({
      departments: z.array(z.string().max(100)).max(30).optional(),
      seniorities: z.array(z.string().max(50)).max(20).optional(),
      titles: z.array(z.string().max(100)).max(50).optional(),
    })
    .optional(),
  market: z.array(z.string().max(50)).max(20).optional(),
  crm: z.string().max(100).optional(),
  leadVolume: z.string().max(50).optional(),
  completedAt: z.string().max(50).optional(),
});

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
  onboarding: onboardingSchema.optional(),
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
