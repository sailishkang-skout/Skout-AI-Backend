import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { loadWorkspaceAccess } from "@skout/auth";
import { apiError, errorResponse } from "../utils/http.js";
import { AccessError, redeemAccessCode, submitAccessRequest } from "../services/access.service.js";

const answersSchema = z
  .object({
    company: z.string().trim().min(1).max(120),
    role_title: z.string().trim().min(1).max(120),
    use_case: z.string().trim().max(1000).optional(),
  })
  .strict();
const redeemSchema = z.object({ code: z.string().trim().min(1).max(32) }).strict();

const REDEEM_ERRORS = {
  invalid: { code: "invalid_code", message: "That code isn't valid." },
  expired: { code: "expired_code", message: "That code has expired." },
  used: { code: "used_code", message: "That code has already been used." },
} as const;

/**
 * Early access, customer side (spec 2026-11-17): the signed-in workspace's access state and feature
 * switches, the pending user's answers, and redeeming the invite code. All three stay reachable while
 * the workspace is pending (access-guard allowlist).
 */
export async function accessRoutes(app: FastifyInstance) {
  async function state(workspaceId: string) {
    const db = app.db!;
    const access = await loadWorkspaceAccess(db, workspaceId);
    const [req] = await db.select().from(schema.accessRequests).where(eq(schema.accessRequests.workspaceId, workspaceId)).limit(1);
    return {
      status: access.status,
      features: access.features,
      request: req
        ? {
            company: req.company,
            role_title: req.roleTitle,
            use_case: req.useCase,
            submitted: !!(req.company && req.roleTitle),
            created_at: req.createdAt.toISOString(),
          }
        : null,
    };
  }

  app.get("/access-request", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    return reply.send({ data: await state(request.workspaceId) });
  });

  app.post("/access-request", async (request, reply) => {
    if (!request.workspaceId || !request.userId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const parsed = answersSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(422).send(errorResponse("Company and role are required", 422, parsed.error.flatten()));
    try {
      await submitAccessRequest(app.db, {
        workspaceId: request.workspaceId,
        userId: request.userId,
        company: parsed.data.company,
        roleTitle: parsed.data.role_title,
        useCase: parsed.data.use_case || null,
      });
    } catch (err) {
      if (err instanceof AccessError) return reply.code(err.status).send(apiError(err.code, err.message, err.status));
      throw err;
    }
    return reply.send({ data: await state(request.workspaceId) });
  });

  app.post(
    "/access-request/redeem",
    {
      config: {
        // preHandler, not onRequest: the limit is per signed-in user, and the user is known only
        // after auth (5 tries an hour per user, spec 2026-11-17).
        rateLimit: {
          hook: "preHandler",
          max: 5,
          timeWindow: "1 hour",
          keyGenerator: (req: { userId?: string; ip: string }) => `access-redeem:${req.userId ?? req.ip}`,
        },
      },
    },
    async (request, reply) => {
      if (!request.workspaceId || !request.userId) return reply.code(401).send(errorResponse("Unauthorized", 401));
      if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));
      const parsed = redeemSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(422).send(apiError(REDEEM_ERRORS.invalid.code, REDEEM_ERRORS.invalid.message, 422));
      const result = await redeemAccessCode(app.db, { workspaceId: request.workspaceId, userId: request.userId, code: parsed.data.code });
      if (!result.ok) {
        const e = REDEEM_ERRORS[result.reason];
        return reply.code(422).send(apiError(e.code, e.message, 422));
      }
      return reply.send({ data: { status: "active" } });
    }
  );
}
