import type { FastifyInstance } from "fastify";
import { createWorkspaceService } from "../services/workspace.service.js";
import { getWorkspaceIcpVersion, isIcpConfigured } from "../services/icp.service.js";
import { startWorkspaceRescoreIfEnabled } from "../services/workspace-rescore.service.js";
import { isRazorpayEnabled } from "../services/billing.service.js";
import type { IcpConfig } from "../services/enrichment/ai-client.js";
import { errorResponse } from "../utils/http.js";

export async function workspaceRoutes(app: FastifyInstance) {
  if (!app.db) {
    app.log.warn("Database not available — workspace routes disabled");
    return;
  }

  const svc = createWorkspaceService(app.db);

  // GET /api/v1/workspaces/current
  app.get("/workspaces/current", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    const workspace = await svc.getWorkspaceWithCredits(request.workspaceId);
    if (!workspace) {
      return reply.code(404).send(errorResponse("Workspace not found", 404));
    }
    return reply.send({ data: workspace });
  });

  // PATCH /api/v1/workspaces/current — rename workspace
  app.patch("/workspaces/current", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    const { name } = request.body as { name?: string };
    if (!name || typeof name !== "string" || name.trim().length === 0 || name.length > 100) {
      return reply.code(400).send(errorResponse("Name is required (1-100 characters)", 400));
    }
    const updated = await svc.renameWorkspace(request.workspaceId, name.trim());
    if (!updated) {
      return reply.code(404).send(errorResponse("Workspace not found", 404));
    }
    return reply.send({ data: updated });
  });

  // GET /api/v1/credits/balance
  app.get("/credits/balance", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    const balance = await svc.getCreditBalance(request.workspaceId);
    return reply.send({ data: balance });
  });

  // GET /api/v1/credits/transactions
  app.get("/credits/transactions", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit ?? "50", 10) || 50, 100);
    const offset = parseInt(query.offset ?? "0", 10) || 0;
    const result = await svc.getCreditTransactions(request.workspaceId, limit, offset);
    return reply.send(result);
  });

  // POST /api/v1/credits/topup — local/dev fallback when Razorpay is not the billing path
  app.post("/credits/topup", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    if (!request.role || !["owner", "admin"].includes(request.role)) {
      return reply
        .code(403)
        .send(errorResponse("Only workspace owners or admins can top up credits", 403));
    }
    if (app.config.NODE_ENV === "production" && isRazorpayEnabled(app.config)) {
      return reply
        .code(403)
        .send(errorResponse("Manual top-up is disabled; buy credits via Razorpay", 403));
    }
    const body = (request.body ?? {}) as { amount?: number };
    const maxAmount = app.config.NODE_ENV === "production" ? 500 : 10_000;
    const amount = Math.min(Math.max(Number(body.amount) || 100, 1), maxAmount);
    const balance = await svc.addCredits(request.workspaceId, amount, "admin_topup");
    return reply.send({ data: { balance, amount } });
  });

  // GET /api/v1/icp
  app.get("/icp", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    const icp = await svc.getIcp(request.workspaceId);
    return reply.send({ data: icp ?? null });
  });

  // PUT /api/v1/icp
  app.put("/icp", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    const config = request.body as IcpConfig;
    const previousVersion = await getWorkspaceIcpVersion(app.db, request.workspaceId);
    const icp = await svc.upsertIcp(request.workspaceId, config as Record<string, unknown>);
    const version = icp?.version ?? 1;

    let rescoreJob = null;
    if (isIcpConfigured(config) && version > previousVersion) {
      try {
        rescoreJob = await startWorkspaceRescoreIfEnabled(
          app.db,
          app.config,
          request.workspaceId,
          config,
          version,
          previousVersion
        );
      } catch (err) {
        request.log.warn({ err, workspaceId: request.workspaceId }, "ICP rescore enqueue failed");
      }
    }

    return reply.send({ data: icp, rescoreJob });
  });
}
