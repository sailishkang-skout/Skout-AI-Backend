import type { FastifyInstance } from "fastify";
import {
  checkHubSpotSchemaDrift,
  getCrmConnectorHealth,
  listCrmOutboundWrites,
  replayCrmOutboundWrite,
} from "../services/crm-observability.service.js";
import { getCrmConnector } from "../services/crm-connector.registry.js";
import { errorResponse, HttpError, requireWorkspaceId } from "../utils/http.js";
import { createDefaultCredentialsStore, ensureFreshTokens } from "../services/crm-export.runner.js";
import { crmAdminGate, sendHttpError } from "./crm-admin-gate.js";

export async function crmObservabilityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", crmAdminGate(app));

  /**
   * GET /crm/:provider/health
   * Returns connector health status, last sync timestamp, queue backlog,
   * failed DLQ records, pending conflict counts, and rate-limit backoff state.
   */
  app.get("/crm/:provider/health", async (request, reply) => {
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
      const health = await getCrmConnectorHealth(app.db, workspaceId, provider);
      return reply.send({ data: health });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      throw err;
    }
  });

  /**
   * GET /crm/outbound-writes
   * Lists per-record outbound writes (sync history and Dead Letter Queue).
   */
  app.get("/crm/outbound-writes", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);

    if (!app.db) {
      return reply.status(503).send(errorResponse("Database unavailable", 503));
    }

    const query = (request.query ?? {}) as {
      status?: string;
      entityType?: string;
      entityId?: string;
      limit?: string;
      offset?: string;
    };

    const limit = query.limit ? Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200) : 50;
    const offset = query.offset ? Math.max(parseInt(query.offset, 10) || 0, 0) : 0;

    try {
      const writes = await listCrmOutboundWrites(app.db, workspaceId, {
        status: query.status,
        entityType: query.entityType,
        entityId: query.entityId && /^[0-9a-f-]{36}$/i.test(query.entityId) ? query.entityId : undefined,
        limit,
        offset,
      });

      return reply.send({
        data: writes,
        limit,
        offset,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      throw err;
    }
  });

  /**
   * POST /crm/outbound-writes/:id/replay
   * Replays a failed outbound write from the Dead Letter Queue (DLQ).
   */
  app.post("/crm/outbound-writes/:id/replay", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const { id } = request.params as { id: string };

    if (!app.db) {
      return reply.status(503).send(errorResponse("Database unavailable", 503));
    }

    try {
      const result = await replayCrmOutboundWrite(app.db, workspaceId, id, request.userId);
      return reply.send({
        ok: true,
        data: result,
      });
    } catch (err) {
      if (sendHttpError(reply, err)) return reply;
      throw err;
    }
  });

  /**
   * POST /crm/:provider/schema-drift
   * Checks the mappings against the provider's live property list now (the poll does it daily)
   * and alerts the admins about mapped fields the provider no longer has.
   */
  app.post("/crm/:provider/schema-drift", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const { provider } = request.params as { provider: string };

    const connector = getCrmConnector(provider);
    if (!connector) {
      return reply.status(404).send(errorResponse(`Unsupported CRM provider: ${provider}`, 404));
    }
    if (provider !== "hubspot") {
      return reply.status(400).send(errorResponse(`Schema checks not implemented for ${provider}`, 400));
    }
    if (!app.db) {
      return reply.status(503).send(errorResponse("Database unavailable", 503));
    }

    try {
      const tokens = await ensureFreshTokens(app.db, app.config, createDefaultCredentialsStore(app.config), workspaceId);
      const result = await checkHubSpotSchemaDrift(app.db, app.config, workspaceId, tokens.accessToken);
      return reply.send({ ok: true, data: result });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      throw err;
    }
  });
}
