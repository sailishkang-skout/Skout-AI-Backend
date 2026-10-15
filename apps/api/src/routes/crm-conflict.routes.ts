import type { FastifyInstance } from "fastify";
import { listCrmConflicts, resolveCrmConflict } from "../services/crm-conflict.service.js";
import { errorResponse, HttpError, requireWorkspaceId } from "../utils/http.js";

export async function crmConflictRoutes(app: FastifyInstance) {
  /**
   * GET /crm/conflicts
   * Lists detected CRM sync conflicts for admin review.
   */
  app.get("/crm/conflicts", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);

    if (!app.db) {
      return reply.status(503).send(errorResponse("Database unavailable", 503));
    }

    const query = (request.query ?? {}) as {
      status?: string;
      entityType?: string;
      limit?: string;
      offset?: string;
    };

    const limit = query.limit ? Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200) : 50;
    const offset = query.offset ? Math.max(parseInt(query.offset, 10) || 0, 0) : 0;

    try {
      const conflicts = await listCrmConflicts(app.db, workspaceId, {
        status: query.status,
        entityType: query.entityType,
        limit,
        offset,
      });

      return reply.send({
        data: conflicts,
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
   * POST /crm/conflicts/:id/resolve
   * Resolves a pending CRM conflict by choosing Skout value, External value, or custom override.
   */
  app.post("/crm/conflicts/:id/resolve", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const { id } = request.params as { id: string };

    if (!app.db) {
      return reply.status(503).send(errorResponse("Database unavailable", 503));
    }

    const body = (request.body ?? {}) as {
      choice: "skout" | "external" | "custom";
      customValue?: string;
    };

    if (!body.choice || !["skout", "external", "custom"].includes(body.choice)) {
      return reply.status(400).send(errorResponse("choice must be 'skout', 'external', or 'custom'", 400));
    }

    const userId = (request as any).userId ?? (request as any).user?.id;

    try {
      const result = await resolveCrmConflict(app.db, workspaceId, id, {
        choice: body.choice,
        customValue: body.customValue,
        resolvedBy: userId,
      });

      return reply.send({
        ok: true,
        data: result,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return reply.status(404).send(errorResponse(msg, 404));
      }
      throw err;
    }
  });
}
