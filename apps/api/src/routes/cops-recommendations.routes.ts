import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getMemberPermissions } from "@skout/auth";
import { copsErrorBody, resolveCorrelationId } from "@skout/shared";
import { requireAnyCopsPermission } from "../services/cops-platform.service.js";
import { enqueueAutomationRunAdvance } from "../workers/automation-run.queue.js";
import {
  approveRecommendation,
  dismissRecommendation,
  generateRecommendations,
  listRecommendations,
  openRouterModel,
  RecommendationError,
  type RecContext,
} from "../services/cops-recommendations.service.js";

/**
 * COPS-13 AI recommendations on Customer 360 (Bible p.83, p.61). Reading needs crm:read; generating,
 * approving and dismissing need crm:write (commercial types also commercial:write). Nothing runs
 * before approval. Errors use the COPS envelope.
 */
type Reply = { status: (code: number) => Reply; send: (body: unknown) => unknown };

export async function copsRecommendationsRoutes(app: FastifyInstance) {
  const db = () => {
    if (!app.db) throw new RecommendationError("NOT_FOUND", "Database not available");
    return app.db;
  };
  const perms = (ws: string, user: string) => getMemberPermissions(db(), ws, user);
  const readGate = { preHandler: requireAnyCopsPermission(["crm:read"], perms) };
  const writeGate = { preHandler: requireAnyCopsPermission(["crm:write"], perms) };
  const idParams = z.object({ id: z.string().uuid() });

  async function ctxOf(r: { workspaceId?: string; userId?: string; headers: Record<string, unknown> }): Promise<RecContext> {
    return { workspaceId: r.workspaceId!, userId: r.userId!, requestId: resolveCorrelationId(r.headers["x-request-id"] as string | undefined), permissions: await perms(r.workspaceId!, r.userId!) };
  }
  async function run(reply: Reply, requestId: string, fn: () => Promise<unknown>) {
    try {
      return reply.status(200).send(await fn());
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(422).send(
          copsErrorBody({ code: "VALIDATION_FAILED", message: error.issues[0]?.message ?? "Invalid request", requestId, details: { fields: error.issues.map((i) => ({ path: i.path.join(".") || "body", message: i.message })) } })
        );
      }
      if (error instanceof RecommendationError) return reply.status(error.status).send(copsErrorBody({ code: error.code, message: error.message, requestId, details: error.details }));
      throw error;
    }
  }

  app.get("/accounts/:id/recommendations", readGate, async (request, reply) => {
    const ctx = await ctxOf(request);
    return run(reply, ctx.requestId, async () => {
      const { id } = idParams.parse(request.params);
      const { status } = z.object({ status: z.enum(["pending", "approved", "dismissed", "expired"]).optional() }).parse(request.query ?? {});
      return { data: await listRecommendations(db(), ctx, id, status) };
    });
  });

  app.post("/accounts/:id/recommendations/generate", writeGate, async (request, reply) => {
    const ctx = await ctxOf(request);
    return run(reply, ctx.requestId, async () => {
      const { id } = idParams.parse(request.params);
      return generateRecommendations(db(), ctx, id, openRouterModel(app.config.OPENROUTER_API_KEY));
    });
  });

  app.post("/recommendations/:id/approve", writeGate, async (request, reply) => {
    const ctx = await ctxOf(request);
    return run(reply, ctx.requestId, async () => {
      const { id } = idParams.parse(request.params);
      const { note } = z.object({ note: z.string().max(1000).optional() }).parse(request.body ?? {});
      const { data, runToEnqueue } = await approveRecommendation(db(), ctx, id, note);
      if (runToEnqueue) {
        enqueueAutomationRunAdvance(app.config, { automationRunId: runToEnqueue, workspaceId: ctx.workspaceId }).catch((err: unknown) =>
          app.log.error({ err, runId: runToEnqueue }, "Failed to enqueue the playbook run for an approved recommendation")
        );
      }
      return { data };
    });
  });

  app.post("/recommendations/:id/dismiss", writeGate, async (request, reply) => {
    const ctx = await ctxOf(request);
    return run(reply, ctx.requestId, async () => {
      const { id } = idParams.parse(request.params);
      const { reason } = z.object({ reason: z.string().max(1000).optional() }).parse(request.body ?? {});
      return { data: await dismissRecommendation(db(), ctx, id, reason) };
    });
  });
}
