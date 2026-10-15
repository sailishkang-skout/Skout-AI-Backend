import type { FastifyInstance } from "fastify";
import { getCrmSyncOptIn, updateCrmSyncOptIn } from "../services/crm-opt-in.service.js";
import { runInitialCrmImport } from "../services/crm-initial-import.service.js";
import { syncHubSpotNativeOrThrow } from "../services/crm-hubspot-native-sync.service.js";
import { getCrmConnector } from "../services/crm-connector.registry.js";
import { errorResponse, HttpError, requireWorkspaceId } from "../utils/http.js";

export async function crmImportRoutes(app: FastifyInstance) {
  /**
   * GET /crm/:provider/opt-in
   * Returns current sync opt-in configuration (ADR 0014).
   */
  app.get("/crm/:provider/opt-in", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const { provider } = request.params as { provider: string };

    const connector = getCrmConnector(provider);
    if (!connector) {
      return reply.status(404).send(errorResponse(`Unsupported CRM provider: ${provider}`, 404));
    }

    if (!app.db) {
      return reply.status(503).send(errorResponse("Database unavailable", 503));
    }

    try {
      const optIn = await getCrmSyncOptIn(app.db, workspaceId, provider);
      return reply.send({ data: optIn });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return reply.status(404).send(errorResponse(msg, 404));
      }
      throw err;
    }
  });

  /**
   * PUT /crm/:provider/opt-in
   * Updates sync opt-in configuration (syncEnabled, accountScope, objectScope).
   */
  app.put("/crm/:provider/opt-in", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const { provider } = request.params as { provider: string };

    const connector = getCrmConnector(provider);
    if (!connector) {
      return reply.status(404).send(errorResponse(`Unsupported CRM provider: ${provider}`, 404));
    }

    if (!app.db) {
      return reply.status(503).send(errorResponse("Database unavailable", 503));
    }

    const body = (request.body ?? {}) as {
      syncEnabled?: boolean;
      accountScope?: string[];
      objectScope?: { contacts?: boolean; deals?: boolean };
      pollIntervalMinutes?: number;
    };

    const userId = (request as any).userId ?? (request as any).user?.id;

    try {
      const updated = await updateCrmSyncOptIn(app.db, workspaceId, provider, body, userId);
      return reply.send({ ok: true, data: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return reply.status(404).send(errorResponse(msg, 404));
      }
      throw err;
    }
  });

  /**
   * POST /crm/:provider/import
   * Triggers or runs an initial resumable paged import.
   */
  app.post("/crm/:provider/import", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const { provider } = request.params as { provider: string };

    const connector = getCrmConnector(provider);
    if (!connector) {
      return reply.status(404).send(errorResponse(`Unsupported CRM provider: ${provider}`, 404));
    }

    if (!app.db) {
      return reply.status(503).send(errorResponse("Database unavailable", 503));
    }

    const body = (request.body ?? {}) as {
      resetCheckpoint?: boolean;
      maxBatches?: number;
      batchSize?: number;
    };

    const userId = (request as any).userId ?? (request as any).user?.id;

    try {
      const result = await runInitialCrmImport(app.db, app.config, workspaceId, provider, {
        resetCheckpoint: body.resetCheckpoint,
        maxBatches: body.maxBatches,
        batchSize: body.batchSize,
        actorId: userId,
      });

      return reply.send({ ok: true, data: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not enabled")) {
        return reply.status(403).send(errorResponse(msg, 403));
      }
      if (msg.includes("not connected")) {
        return reply.status(400).send(errorResponse(msg, 400));
      }
      if (msg.includes("not found")) {
        return reply.status(404).send(errorResponse(msg, 404));
      }
      throw err;
    }
  });

  /**
   * POST /crm/:provider/poll
   * Triggers an on-demand incremental poll run for this workspace and provider.
   */
  app.post("/crm/:provider/poll", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const { provider } = request.params as { provider: string };

    const connector = getCrmConnector(provider);
    if (!connector) {
      return reply.status(404).send(errorResponse(`Unsupported CRM provider: ${provider}`, 404));
    }

    if (!app.db) {
      return reply.status(503).send(errorResponse("Database unavailable", 503));
    }

    const body = (request.body ?? {}) as {
      maxContacts?: number;
      maxDeals?: number;
    };

    try {
      if (provider === "hubspot") {
        const result = await syncHubSpotNativeOrThrow(app.db, app.config, workspaceId, {
          maxContacts: body.maxContacts,
          maxDeals: body.maxDeals,
        });
        return reply.send({ ok: true, data: result });
      }

      return reply.status(400).send(errorResponse(`Polling not implemented for ${provider}`, 400));
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      throw err;
    }
  });
}
