import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorResponse } from "../utils/http.js";
import { buildConsentService } from "../services/consent.service.js";

const recordSchema = z.object({
  subjectType: z.string().min(1),
  subjectId: z.string().min(1),
  type: z.string().min(1),
  basis: z.string().min(1),
});

const listQuerySchema = z.object({
  subjectType: z.string().min(1),
  subjectId: z.string().min(1),
});

const checkQuerySchema = z.object({
  subjectType: z.string().min(1),
  subjectId: z.string().min(1),
  type: z.string().min(1),
});

/**
 * §5.1 (Enterprise Completion Plan) — consent capture endpoints. Open to any authenticated
 * workspace member (no role gate), matching the same "any service/user acting on behalf of the
 * workspace may record it" posture evidence.routes.ts already uses for evidence writes — a
 * consent record is provenance/compliance bookkeeping on an action already taken (a prospect
 * opted in through some real channel), not itself a privileged action.
 */
export async function consentRoutes(app: FastifyInstance) {
  const service = () => buildConsentService(app.db ?? null);

  app.post("/consents", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));

    const parsed = recordSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid consent payload", 400, parsed.error.flatten()));
    }

    const consent = await svc.record({
      workspaceId: request.workspaceId,
      ...parsed.data,
      recordedBy: request.userId,
    });
    return reply.code(201).send({ data: consent });
  });

  app.post<{ Params: { id: string } }>("/consents/:id/revoke", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));

    // svc.revoke() throws HttpError (consent_not_found / consent_already_revoked) — caught by
    // app.ts's global setErrorHandler, same as every other route in this API that throws
    // HttpError without a local try/catch (see companies.routes.ts's DELETE handler).
    const consent = await svc.revoke(request.workspaceId, request.params.id);
    return reply.send({ data: consent });
  });

  app.get("/consents", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.send({ data: [], total: 0 });

    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid query", 400, parsed.error.flatten()));
    }

    const data = await svc.list(request.workspaceId, parsed.data.subjectType, parsed.data.subjectId);
    return reply.send({ data, total: data.length });
  });

  /** The check a sending/processing path is meant to call before acting on a subject. */
  app.get("/consents/check", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    // Fail closed: no service (DB unavailable) means "cannot confirm consent" -> false, not 200.
    if (!svc) return reply.send({ data: { hasActiveConsent: false } });

    const parsed = checkQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid query", 400, parsed.error.flatten()));
    }

    const hasActiveConsent = await svc.hasActive(
      request.workspaceId,
      parsed.data.subjectType,
      parsed.data.subjectId,
      parsed.data.type
    );
    return reply.send({ data: { hasActiveConsent } });
  });
}
