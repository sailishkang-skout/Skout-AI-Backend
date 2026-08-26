import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorResponse } from "../utils/http.js";
import { generateRegionalBrief } from "../services/regional-intel.service.js";
import {
  assertRegionalTamValidated,
  getRegionalTamGate,
} from "../services/regional-tam-gate.service.js";

/**
 * §16 i18n / Regional TAM / sales territory — LLM-assisted regional brief.
 * §3 global-by-model: tam/competitive purposes require ≥4 win/loss deals.
 */
const bodySchema = z.object({
  location: z.string().min(2).max(120),
  locale: z.string().min(2).max(32).optional(),
  purpose: z.enum(["tam", "territory", "competitive", "onboarding"]).default("onboarding"),
  companyIndustry: z.string().max(120).optional(),
  productDescription: z.string().max(2000).optional(),
});

export async function regionalIntelRoutes(app: FastifyInstance) {
  app.get("/regional-intel/gate", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    return reply.send({ data: await getRegionalTamGate(app.db, request.workspaceId) });
  });

  app.post("/regional-intel", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));

    const parsed = bodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid regional-intel payload", 400, parsed.error.flatten()));
    }

    let gateMeta: { gate: string; dealsReviewed: number; minDeals?: number } | null = null;
    if (app.db) {
      try {
        gateMeta = await assertRegionalTamValidated(app.db, request.workspaceId, {
          purpose: parsed.data.purpose,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "regional_tam_gate";
        const details =
          err && typeof err === "object" && "details" in err ? (err as { details: unknown }).details : null;
        return reply.status(422).send(errorResponse(message, 422, details));
      }
    }

    try {
      const brief = await generateRegionalBrief(parsed.data, app.config.OPENROUTER_API_KEY);
      return reply.send({
        data: brief,
        regionalTamGate: gateMeta,
        unverified: gateMeta?.gate !== "validated",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "regional_intel_failed";
      return reply.status(502).send(errorResponse(message, 502));
    }
  });
}
