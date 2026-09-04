import type { EnrichField } from "@skout/pal";
import { buildEnrichmentService, InsufficientCreditsError, type ProspectSnapshot } from "../enrichment/index.js";
import { HttpError } from "../../utils/http.js";
import type { NodeHandler } from "./types.js";

/**
 * §8.14 SP-08 — wraps the same enrichment-waterfall engine (packages/pal/src/engine.ts, via
 * EnrichmentService.enrichProspect) that /prospects/:id/enrich uses, so a workflow step spends
 * real provider credits and writes the same job/results shape as every other enrichment entry
 * point — not a second, divergent enrichment path.
 *
 * Config: { companyDomain: string; prospectId?: string; fields?: EnrichField[]; ...other
 * ProspectSnapshot fields the run already knows (fullName, title, email, etc.) }.
 */
export const enrichmentActionNodeHandler: NodeHandler = async (ctx) => {
  const { fields, ...snapshot } = ctx.node.config as { fields?: EnrichField[] } & Partial<ProspectSnapshot>;

  if (!snapshot.companyDomain?.trim()) {
    throw new HttpError("Enrichment action node requires companyDomain", 422);
  }

  if (ctx.isSimulation) {
    return { output: { simulated: true, companyDomain: snapshot.companyDomain, fields: fields ?? null } };
  }

  const svc = buildEnrichmentService(ctx.db, ctx.config);
  try {
    const job = await svc.enrichProspect(ctx.workspaceId, snapshot as ProspectSnapshot, {
      fields,
      trigger: "workflow",
    });
    return {
      output: {
        jobId: job.id,
        status: job.status,
        creditsUsed: job.creditsUsed,
        results: job.results,
      },
    };
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      throw new HttpError(`Insufficient credits for enrichment: need ${err.required}, have ${err.available}`, 402);
    }
    throw err;
  }
};
