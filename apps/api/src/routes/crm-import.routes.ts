import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCrmSyncOptIn, updateCrmSyncOptIn } from "../services/crm-opt-in.service.js";
import { runInitialCrmImport } from "../services/crm-initial-import.service.js";
import { syncHubSpotNativeOrThrow } from "../services/crm-hubspot-native-sync.service.js";
import { getCrmConnector } from "../services/crm-connector.registry.js";
import { errorResponse, requireWorkspaceId } from "../utils/http.js";
import { crmAdminGate, sendHttpError } from "./crm-admin-gate.js";

const optInBody = z
  .object({
    syncEnabled: z.boolean().optional(),
    // Skout company (account) ids, or ["*"] for every account.
    accountScope: z.array(z.union([z.literal("*"), z.string().uuid()])).min(1).max(500).optional(),
    objectScope: z.object({ contacts: z.boolean().optional(), deals: z.boolean().optional() }).strict().optional(),
    pollIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  })
  .strict();

const importBody = z
  .object({
    resetCheckpoint: z.boolean().optional(),
    maxBatches: z.number().int().min(1).max(50).optional(),
    batchSize: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const pollBody = z
  .object({
    maxContacts: z.number().int().min(1).max(500).optional(),
    maxDeals: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export async function crmImportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", crmAdminGate(app));

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
   * Updates sync opt-in configuration (syncEnabled, accountScope, objectScope, pollIntervalMinutes).
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

    const parsed = optInBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(422).send(errorResponse("Invalid opt-in settings", 422, parsed.error.flatten()));
    }

    try {
      const updated = await updateCrmSyncOptIn(app.db, workspaceId, provider, parsed.data, request.userId);
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
   * Runs a resumable, paged initial import (sync must be turned on first).
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

    const parsed = importBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(422).send(errorResponse("Invalid import options", 422, parsed.error.flatten()));
    }

    try {
      const result = await runInitialCrmImport(app.db, app.config, workspaceId, provider, {
        ...parsed.data,
        actorId: request.userId,
      });
      return reply.send({ ok: true, data: result });
    } catch (err) {
      if (sendHttpError(reply, err)) return reply;
      throw err;
    }
  });

  /**
   * POST /crm/:provider/poll
   * Runs one incremental poll now for this workspace (sync must be turned on first).
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

    const parsed = pollBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(422).send(errorResponse("Invalid poll options", 422, parsed.error.flatten()));
    }

    try {
      if (provider === "hubspot") {
        const result = await syncHubSpotNativeOrThrow(app.db, app.config, workspaceId, parsed.data);
        return reply.send({ ok: true, data: result });
      }

      return reply.status(400).send(errorResponse(`Polling not implemented for ${provider}`, 400));
    } catch (err) {
      if (sendHttpError(reply, err)) return reply;
      throw err;
    }
  });
}
