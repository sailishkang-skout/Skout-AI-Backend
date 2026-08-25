import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorResponse } from "../utils/http.js";
import { generateRegionalBrief } from "../services/regional-intel.service.js";

/**
 * §16 i18n / Regional TAM / sales territory — LLM-assisted regional brief.
 * Seller location comes from onboarding (company.hqCountry / locale); this endpoint
 * expands it into actionable regional intel for TAM + territory planning.
 */
const bodySchema = z.object({
  location: z.string().min(2).max(120),
  locale: z.string().min(2).max(32).optional(),
  purpose: z.enum(["tam", "territory", "competitive", "onboarding"]).default("onboarding"),
  companyIndustry: z.string().max(120).optional(),
  productDescription: z.string().max(2000).optional(),
});

export async function regionalIntelRoutes(app: FastifyInstance) {
  app.post("/regional-intel", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));

    const parsed = bodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid regional-intel payload", 400, parsed.error.flatten()));
    }

    try {
      const brief = await generateRegionalBrief(parsed.data, app.config.OPENROUTER_API_KEY);
      return reply.send({ data: brief });
    } catch (err) {
      const message = err instanceof Error ? err.message : "regional_intel_failed";
      return reply.status(502).send(errorResponse(message, 502));
    }
  });
}
