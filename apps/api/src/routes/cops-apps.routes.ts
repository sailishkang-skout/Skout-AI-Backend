import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getMemberPermissions } from "@skout/auth";
import { copsErrorBody, resolveCorrelationId } from "@skout/shared";
import { requireCopsPermission } from "../services/cops-platform.service.js";
import {
  API_SCOPES,
  ApiCredentialError,
  createApp,
  createKey,
  listApps,
  revokeKey,
  setAppStatus,
  type CredCtx,
} from "../services/cops-api-credentials.service.js";

/**
 * COPS-14 integration framework: connected apps and their scoped API keys. Admin only.
 * A new key is returned once, in the create response; afterwards only its preview is shown.
 */
type Reply = { status: (code: number) => Reply; send: (body: unknown) => unknown };

const reason = z.string().trim().min(8, "Give a reason of at least 8 characters").max(500);
const appBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().max(300).optional(),
  homepage_url: z.string().url().max(300).optional(),
});
const keyBody = z.object({
  name: z.string().trim().min(2).max(60),
  scopes: z.array(z.string()).min(1).max(20),
  expires_in_days: z.number().int().min(1).max(730).optional(),
});
const idParams = z.object({ id: z.string().uuid() });
const STATUS: Record<ApiCredentialError["code"], number> = { NOT_FOUND: 404, VALIDATION_FAILED: 422, BUSINESS_STATE_CONFLICT: 409 };

export async function copsAppsRoutes(app: FastifyInstance) {
  const db = () => {
    if (!app.db) throw new ApiCredentialError("NOT_FOUND", "Database not available");
    return app.db;
  };
  const gate = { preHandler: requireCopsPermission("admin", "admin", (ws, user) => getMemberPermissions(db(), ws, user)) };
  const ctxOf = (r: { workspaceId?: string; userId?: string; headers: Record<string, unknown> }): CredCtx => ({
    workspaceId: r.workspaceId!,
    userId: r.userId!,
    requestId: resolveCorrelationId(r.headers["x-request-id"] as string | undefined),
  });
  async function run(reply: Reply, requestId: string, fn: () => Promise<unknown>, created = false) {
    try {
      return reply.status(created ? 201 : 200).send({ data: await fn() });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(422).send(
          copsErrorBody({ code: "VALIDATION_FAILED", message: error.issues[0]?.message ?? "Invalid request", requestId, details: { fields: error.issues.map((i) => ({ path: i.path.join(".") || "body", message: i.message })) } })
        );
      }
      if (error instanceof ApiCredentialError) return reply.status(STATUS[error.code]).send(copsErrorBody({ code: error.code, message: error.message, requestId }));
      throw error;
    }
  }

  app.get("/cops/api-scopes", gate, async (request, reply) =>
    run(reply, ctxOf(request).requestId, async () => Object.entries(API_SCOPES).map(([key, v]) => ({ key, label: v.label })))
  );

  app.get("/cops/apps", gate, async (request, reply) => {
    const ctx = ctxOf(request);
    return run(reply, ctx.requestId, () => listApps(db(), ctx.workspaceId));
  });

  app.post("/cops/apps", gate, async (request, reply) => {
    const ctx = ctxOf(request);
    return run(reply, ctx.requestId, () => createApp(db(), ctx, appBody.parse(request.body ?? {})), true);
  });

  app.post("/cops/apps/:id/status", gate, async (request, reply) => {
    const ctx = ctxOf(request);
    return run(reply, ctx.requestId, async () => {
      const { id } = idParams.parse(request.params);
      const body = z.object({ status: z.enum(["active", "disabled"]), reason }).parse(request.body ?? {});
      return setAppStatus(db(), ctx, id, body.status, body.reason);
    });
  });

  app.post("/cops/apps/:id/keys", gate, async (request, reply) => {
    const ctx = ctxOf(request);
    return run(
      reply,
      ctx.requestId,
      async () => {
        const { id } = idParams.parse(request.params);
        return createKey(db(), ctx, id, keyBody.parse(request.body ?? {}));
      },
      true
    );
  });

  app.post("/cops/api-keys/:id/revoke", gate, async (request, reply) => {
    const ctx = ctxOf(request);
    return run(reply, ctx.requestId, async () => {
      const { id } = idParams.parse(request.params);
      const body = z.object({ reason }).parse(request.body ?? {});
      return revokeKey(db(), ctx, id, body.reason);
    });
  });
}
