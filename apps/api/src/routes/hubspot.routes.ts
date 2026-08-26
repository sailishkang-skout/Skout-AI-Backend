import type { FastifyInstance } from "fastify";
import { createCrmService } from "../services/crm.service.js";
import { syncHubSpotNativeOrThrow } from "../services/crm-hubspot-native-sync.service.js";
import { HttpError, errorResponse } from "../utils/http.js";

export async function hubspotRoutes(app: FastifyInstance) {
  const svc = () => createCrmService(app.db, app.config);

  app.get("/crm/connections", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    return reply.send(await svc().listConnections(workspaceId));
  });

  app.post("/crm/hubspot/connect", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    try {
      return reply.send(svc().getHubSpotConnectUrl(workspaceId));
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });

  app.get("/crm/hubspot/callback", async (request, reply) => {
    const { code, state, error } = request.query as {
      code?: string;
      state?: string;
      error?: string;
    };
    const frontend = app.config.FRONTEND_URL ?? app.config.CORS_ORIGIN[0] ?? "http://localhost:3000";
    // Next.js basePath is "/app" — omitting it 404'd this redirect even on success.
    const failUrl = `${frontend.replace(/\/$/, "")}/app/settings/crm?hubspot=error`;

    if (error || !code || !state) {
      return reply.redirect(failUrl);
    }

    try {
      const successUrl = await svc().handleHubSpotCallback(code, state);
      return reply.redirect(successUrl);
    } catch (err) {
      app.log.error({ err }, "HubSpot OAuth callback failed");
      return reply.redirect(failUrl);
    }
  });

  app.delete("/crm/hubspot", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    try {
      await svc().disconnectHubSpot(workspaceId);
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });

  app.get("/crm/hubspot/lists", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    try {
      return reply.send(await svc().listHubSpotLists(workspaceId));
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });

  app.post("/crm/hubspot/import", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const body = (request.body ?? {}) as {
      source?: "all" | "list";
      hubspotListId?: string;
      targetListId?: string;
      newListName?: string;
      maxContacts?: number;
    };
    if (body.source !== "all" && body.source !== "list") {
      return reply.status(400).send(errorResponse("invalid_import_source", 400));
    }
    if (!body.targetListId && !body.newListName?.trim()) {
      return reply.status(400).send(errorResponse("import_target_required", 400));
    }
    try {
      return reply.status(201).send(
        await svc().importFromHubSpot(workspaceId, {
          source: body.source,
          hubspotListId: body.hubspotListId,
          targetListId: body.targetListId,
          newListName: body.newListName,
          maxContacts: body.maxContacts,
        })
      );
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });

  /** §8.12 — inbound HubSpot → native CRM sync (manual-wins conflict rules). */
  app.post("/crm/hubspot/sync-native", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    if (!app.db) return reply.status(503).send(errorResponse("Database unavailable", 503));
    const body = (request.body ?? {}) as { maxContacts?: number; maxDeals?: number; includeDeals?: boolean };
    try {
      const result = await syncHubSpotNativeOrThrow(app.db, app.config, workspaceId, body);
      return reply.send({ data: result });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });

  /**
   * §8.12 — HubSpot webhook receiver. Verifies X-HubSpot-Signature, then triggers a bounded
   * native sync for the workspace identified by query `workspaceId` (configured in HubSpot
   * subscription URL). Public — signature is the auth.
   */
  app.post("/crm/hubspot/webhook", async (request, reply) => {
    if (!app.db) return reply.status(503).send(errorResponse("Database unavailable", 503));
    const secret = app.config.HUBSPOT_CLIENT_SECRET;
    if (!secret) return reply.status(503).send(errorResponse("hubspot_not_configured", 503));

    const { verifyHubSpotWebhookSignature } = await import("../services/hubspot.client.js");
    const raw =
      typeof request.body === "string"
        ? request.body
        : Buffer.isBuffer(request.body)
          ? request.body.toString("utf8")
          : JSON.stringify(request.body ?? {});
    const sig = request.headers["x-hubspot-signature"] as string | undefined;
    if (!verifyHubSpotWebhookSignature(secret, raw, sig)) {
      return reply.status(401).send(errorResponse("invalid_signature", 401));
    }

    const workspaceId =
      (request.query as { workspaceId?: string }).workspaceId ??
      (Array.isArray(request.body)
        ? undefined
        : (request.body as { workspaceId?: string } | undefined)?.workspaceId);
    if (!workspaceId) {
      // HubSpot subscription validation / empty payloads
      return reply.send({ ok: true, skipped: "no_workspace" });
    }

    try {
      const result = await syncHubSpotNativeOrThrow(app.db, app.config, workspaceId, {
        maxContacts: 50,
        maxDeals: 50,
      });
      return reply.send({ ok: true, data: result });
    } catch (err) {
      app.log.warn({ err }, "HubSpot webhook sync failed");
      return reply.send({ ok: true, deferred: true });
    }
  });

  app.get("/crm/export-jobs/:jobId", async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const workspaceId = request.workspaceId ?? "unknown";
    try {
      return reply.send(await svc().getExportJob(workspaceId, jobId));
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
      }
      throw err;
    }
  });
}
