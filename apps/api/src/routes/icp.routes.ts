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
  completedAt: z
    .string()
    .max(50)
    .refine((value) => !Number.isNaN(Date.parse(value)), "completedAt must be a valid ISO date")
    .optional(),
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

/** Reject bare completedAt claims — wizard must include minimum profile answers. */
function assertValidOnboardingCompletion(
  onboarding: z.infer<typeof onboardingSchema> | undefined
): void {
  if (!onboarding?.completedAt) return;

  const hasCompany =
    Boolean(onboarding.company?.name?.trim()) &&
    Boolean(onboarding.company?.industry?.trim()) &&
    Boolean(onboarding.company?.size?.trim());
  const hasGoals = (onboarding.goals?.length ?? 0) > 0;
  const hasIcpIndustries = (onboarding.icp?.industries?.length ?? 0) > 0;
  const hasPeople =
    (onboarding.people?.departments?.length ?? 0) > 0 ||
    (onboarding.people?.seniorities?.length ?? 0) > 0 ||
    (onboarding.people?.titles?.length ?? 0) > 0;
  const hasMarket = (onboarding.market?.length ?? 0) > 0;
  const hasLeadVolume = Boolean(onboarding.leadVolume?.trim());

  if (!hasCompany || !hasGoals || !hasIcpIndustries || !hasPeople || !hasMarket || !hasLeadVolume) {
    const err = new Error(
      "Onboarding completion requires company, goals, ICP industries, people targets, market, and lead volume"
    );
    (err as Error & { statusCode: number }).statusCode = 400;
    throw err;
  }
}

function requireWorkspaceId(request: { workspaceId?: string }): string {
  if (!request.workspaceId) {
    const err = new Error("Workspace context required");
    (err as Error & { statusCode: number }).statusCode = 403;
    throw err;
  }
  return request.workspaceId;
}

export async function icpRoutes(app: FastifyInstance) {
  app.get("/workspace/icp", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const config = await getWorkspaceIcp(app.db, workspaceId);
    const version = await getWorkspaceIcpVersion(app.db, workspaceId);
    return reply.send({ workspaceId, config, version: version || undefined });
  });

  app.put("/workspace/icp", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const body = icpSchema.parse(request.body ?? {});
    assertValidOnboardingCompletion(body.onboarding);
    const previousVersion = await getWorkspaceIcpVersion(app.db, workspaceId);
    const row = await setWorkspaceIcp(app.db, workspaceId, body);
    const version = row?.version ?? 1;
    const savedConfig = (row?.config as typeof body | undefined) ?? body;

    let rescoreJob = null;
    if (isIcpConfigured(savedConfig) && version > previousVersion) {
      try {
        rescoreJob = await startWorkspaceRescoreIfEnabled(
          app.db,
          app.config,
          workspaceId,
          savedConfig,
          version,
          previousVersion
        );
      } catch (err) {
        request.log.warn({ err, workspaceId }, "ICP rescore enqueue failed");
      }
    }

    return reply.send({
      workspaceId,
      config: savedConfig,
      version,
      rescoreJob,
    });
  });
}
