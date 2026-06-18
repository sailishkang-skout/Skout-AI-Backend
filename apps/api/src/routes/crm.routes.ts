import type { FastifyInstance } from "fastify";
import { createCrmService } from "../services/crm.service.js";
import { HttpError, errorResponse } from "../utils/http.js";

export async function crmRoutes(app: FastifyInstance) {
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
    const failUrl = `${frontend.replace(/\/$/, "")}/settings/crm?hubspot=error`;

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

export async function webhookRoutes(app: FastifyInstance) {
  app.get("/webhooks", async (_request, reply) => {
    return reply.send({ data: [], total: 0 });
  });
}
