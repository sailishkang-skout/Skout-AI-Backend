import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getMemberPermissions } from "@skout/auth";
import { copsErrorBody, resolveCorrelationId } from "@skout/shared";
import { requireCopsPermission } from "../services/cops-platform.service.js";
import {
  createRole,
  deleteRole,
  getMemberRoles,
  listPermissionCatalog,
  listRoles,
  RoleError,
  setMemberRoles,
  updateRole,
  type RoleCtx,
} from "../services/cops-roles.service.js";
import { DATA_SCOPES, DataScopeError, getDataScope, setDataScope } from "../services/cops-data-scope.service.js";

/**
 * COPS-14 part C: custom roles and member role grants (docs/api/copos-14-custom-roles.openapi.yaml).
 * Every route needs admin:admin. Errors use the COPS envelope.
 */
type Reply = { status: (code: number) => Reply; send: (body: unknown) => unknown };

const reason = z.string().trim().min(3, "A reason is required").max(500);
const keys = z.array(z.string().min(1).max(80)).max(200);
const createBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().max(300).optional(),
  permission_keys: keys.optional(),
  clone_from_role_id: z.string().uuid().optional(),
});
const updateBody = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  description: z.string().max(300).optional(),
  permission_keys: keys.optional(),
  reason,
});

export async function copsRolesRoutes(app: FastifyInstance) {
  const db = () => {
    if (!app.db) throw new RoleError("NOT_FOUND", "Database not available");
    return app.db;
  };
  const perms = (ws: string, user: string) => getMemberPermissions(db(), ws, user);
  const gate = { preHandler: requireCopsPermission("admin", "admin", perms) };
  const idParams = z.object({ id: z.string().uuid() });
  const userParams = z.object({ userId: z.string().uuid() });

  async function ctxOf(r: { workspaceId?: string; userId?: string; headers: Record<string, unknown> }): Promise<RoleCtx> {
    return { workspaceId: r.workspaceId!, userId: r.userId!, requestId: resolveCorrelationId(r.headers["x-request-id"] as string | undefined), permissions: await perms(r.workspaceId!, r.userId!) };
  }
  async function run(reply: Reply, requestId: string, fn: () => Promise<unknown>) {
    try {
      return reply.status(200).send(await fn());
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(422).send(
          copsErrorBody({ code: "VALIDATION_FAILED", message: error.issues[0]?.message ?? "Invalid request", requestId, details: { fields: error.issues.map((i) => ({ path: i.path.join(".") || "body", message: i.message })) } })
        );
      }
      if (error instanceof DataScopeError) return reply.status(error.status).send(copsErrorBody({ code: error.code, message: error.message, requestId }));
      if (error instanceof RoleError) return reply.status(error.status).send(copsErrorBody({ code: error.code, message: error.message, requestId, details: error.details }));
      throw error;
    }
  }

  app.get("/cops/permissions", gate, async (request, reply) => {
    const ctx = await ctxOf(request);
    return run(reply, ctx.requestId, async () => ({ data: await listPermissionCatalog(db()) }));
  });

  app.get("/cops/roles", gate, async (request, reply) => {
    const ctx = await ctxOf(request);
    return run(reply, ctx.requestId, async () => ({ data: await listRoles(db(), ctx.workspaceId) }));
  });

  app.post("/cops/roles", gate, async (request, reply) => {
    const ctx = await ctxOf(request);
    return run(reply, ctx.requestId, async () => ({ data: await createRole(db(), ctx, createBody.parse(request.body ?? {})) }));
  });

  app.patch("/cops/roles/:id", gate, async (request, reply) => {
    const ctx = await ctxOf(request);
    return run(reply, ctx.requestId, async () => {
      const { id } = idParams.parse(request.params);
      return { data: await updateRole(db(), ctx, id, updateBody.parse(request.body ?? {})) };
    });
  });

  app.delete("/cops/roles/:id", gate, async (request, reply) => {
    const ctx = await ctxOf(request);
    return run(reply, ctx.requestId, async () => {
      const { id } = idParams.parse(request.params);
      const body = z.object({ reason }).parse(request.body ?? {});
      return { data: await deleteRole(db(), ctx, id, body.reason) };
    });
  });

  app.get("/cops/members/:userId/roles", gate, async (request, reply) => {
    const ctx = await ctxOf(request);
    return run(reply, ctx.requestId, async () => {
      const { userId } = userParams.parse(request.params);
      return { data: await getMemberRoles(db(), ctx.workspaceId, userId) };
    });
  });

  app.put("/cops/members/:userId/roles", gate, async (request, reply) => {
    const ctx = await ctxOf(request);
    return run(reply, ctx.requestId, async () => {
      const { userId } = userParams.parse(request.params);
      const body = z.object({ role_ids: z.array(z.string().uuid()).max(20), reason }).parse(request.body ?? {});
      return { data: await setMemberRoles(db(), ctx, userId, body.role_ids, body.reason) };
    });
  });

  app.get("/cops/members/:userId/data-scope", gate, async (request, reply) => {
    const ctx = await ctxOf(request);
    return run(reply, ctx.requestId, async () => {
      const { userId } = userParams.parse(request.params);
      await getMemberRoles(db(), ctx.workspaceId, userId);
      return { data: { user_id: userId, scope: await getDataScope(db(), ctx.workspaceId, userId) } };
    });
  });

  app.put("/cops/members/:userId/data-scope", gate, async (request, reply) => {
    const ctx = await ctxOf(request);
    return run(reply, ctx.requestId, async () => {
      const { userId } = userParams.parse(request.params);
      const body = z.object({ scope: z.enum(DATA_SCOPES), reason }).parse(request.body ?? {});
      return { data: await setDataScope(db(), ctx, userId, body.scope, body.reason) };
    });
  });
}
