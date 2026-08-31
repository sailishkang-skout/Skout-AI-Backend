import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorResponse } from "../utils/http.js";
import { buildConsentService } from "../services/consent.service.js";
import {
  addSuppression,
  listSuppressions,
  removeSuppression,
} from "../services/suppression.service.js";

function requireAdmin(request: { role?: string | null }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  if (!request.role || !["owner", "admin"].includes(request.role)) {
    return reply.code(403).send(errorResponse("Requires role: owner or admin", 403));
  }
  return null;
}

/** §16 — Consent + suppression center (unified compliance surface). */
export async function complianceRoutes(app: FastifyInstance) {
  app.get("/suppressions", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const query = z
      .object({
        email: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(request.query ?? {});

    const result = await listSuppressions(app.db, request.workspaceId, query);
    return reply.send(result);
  });

  app.post("/suppressions", async (request, reply) => {
    if (requireAdmin(request, reply)) return;
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));

    const body = z
      .object({
        email: z.string().email(),
        reason: z.string().min(1).default("manual_dnc"),
      })
      .parse(request.body ?? {});

    const row = await addSuppression(app.db, request.workspaceId, body.email, body.reason);
    return reply.code(201).send({ data: row });
  });

  app.delete<{ Params: { id: string } }>("/suppressions/:id", async (request, reply) => {
    if (requireAdmin(request, reply)) return;
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));

    await removeSuppression(app.db, request.workspaceId, request.params.id);
    return reply.code(204).send(null);
  });

  app.get("/compliance/consents", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = buildConsentService(app.db ?? null);
    if (!svc) return reply.send({ data: [], total: 0 });

    const query = z
      .object({
        subjectType: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(request.query ?? {});

    return reply.send(await svc.listWorkspace(request.workspaceId, query));
  });
}
