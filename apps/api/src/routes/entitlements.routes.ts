import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { enforcePermission, recordPrivilegedAction } from "@skout/auth";
import { errorResponse } from "../utils/http.js";
import { buildEntitlementsService } from "../services/entitlements.service.js";
import { isPlatformAdmin } from "../services/regional-brief.service.js";
import { INTERNAL_ACCESS_ENTITLEMENT } from "../services/enrichment/release-gate.js";

const setSchema = z.object({
  value: z.unknown(),
});

/**
 * Entitlements that open an unreleased feature to a workspace (for example LinkedIn
 * enrichment's internal release, ENR-06). They record a decision by Skout, not by the customer,
 * so only a platform admin (PLATFORM_ADMIN_EMAILS) may set or remove them; a workspace owner or
 * admin cannot grant them to their own workspace.
 */
export function isPlatformManagedEntitlement(key: string): boolean {
  return key === INTERNAL_ACCESS_ENTITLEMENT || key.endsWith(".internal_access");
}

const platformManagedResponse = () => ({
  ...errorResponse("This entitlement is managed by Skout and cannot be changed from a workspace.", 403),
  code: "platform_managed_entitlement",
});

/**
 * §5.1 / §11.1 / §16 Task 35 (Enterprise Completion Plan) — entitlements read/write API. Reads
 * are open to any authenticated workspace member (same posture as GET /billing — seeing your
 * own plan limits isn't privileged); writes are owner/admin only, matching the role bar this
 * codebase already uses for other plan/billing-adjacent actions (see team.routes.ts).
 * Platform-managed entitlements (isPlatformManagedEntitlement) are written only by a platform
 * admin, here or through PUT /admin/workspaces/:workspaceId/entitlements/:key.
 */
export async function entitlementsRoutes(app: FastifyInstance) {
  const service = () => buildEntitlementsService(app.db ?? null);

  app.get("/entitlements", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.send({ data: [] });

    const data = await svc.list(request.workspaceId);
    return reply.send({ data });
  });

  async function shadowBillingManage(workspaceId: string, userId: string | undefined, action: string) {
    if (!app.db || !userId) return;
    await enforcePermission(app.db, workspaceId, userId, "billing:manage", {
      enforce: app.config.RBAC_ENFORCEMENT_ENABLED,
      onShadowDeny: (info) =>
        app.log.warn(info, `RBAC shadow-mode: billing:manage would have been denied (${action})`),
    });
  }

  /** Writes a platform-managed entitlement and the audit row for it. */
  async function changePlatformManaged(
    request: FastifyRequest,
    workspaceId: string,
    key: string,
    change: { set: unknown } | { remove: true }
  ) {
    const svc = service()!;
    const existing = await svc.get(workspaceId, key);
    const result = "set" in change ? await svc.set(workspaceId, key, change.set) : (await svc.remove(workspaceId, key), null);
    // The audit row points at the entitlement row (entity_id is a uuid); the key is in the state.
    // Removing a key that was never set leaves nothing to point at and changes nothing.
    const entityId = result?.id ?? existing?.id;
    if (entityId) {
      await recordPrivilegedAction(app.db!, {
        workspaceId,
        actorId: request.userId,
        action: "set" in change ? "entitlement.platform_grant" : "entitlement.platform_revoke",
        entityType: "entitlement",
        entityId,
        beforeState: { key, value: existing?.value ?? null },
        afterState: { key, value: "set" in change ? change.set : null, by: request.userEmail ?? null },
      });
    }
    request.log.info({ workspaceId, key, actor: request.userEmail }, "platform-managed entitlement changed");
    return result;
  }

  app.put<{ Params: { key: string } }>("/entitlements/:key", async (request, reply) => {
    if (!request.workspaceId || !request.role) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const platformManaged = isPlatformManagedEntitlement(request.params.key);
    if (platformManaged && !isPlatformAdmin(app.config, request.userEmail)) {
      return reply.code(403).send(platformManagedResponse());
    }
    if (!platformManaged && !["owner", "admin"].includes(request.role)) {
      return reply.code(403).send(errorResponse("Requires role: owner or admin", 403));
    }
    if (!platformManaged) await shadowBillingManage(request.workspaceId, request.userId, "set entitlement");
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));

    const parsed = setSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid entitlement payload", 400, parsed.error.flatten()));
    }

    const entitlement = platformManaged
      ? await changePlatformManaged(request, request.workspaceId, request.params.key, { set: parsed.data.value })
      : await svc.set(request.workspaceId, request.params.key, parsed.data.value);
    return reply.send({ data: entitlement });
  });

  app.delete<{ Params: { key: string } }>("/entitlements/:key", async (request, reply) => {
    if (!request.workspaceId || !request.role) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const platformManaged = isPlatformManagedEntitlement(request.params.key);
    if (platformManaged && !isPlatformAdmin(app.config, request.userEmail)) {
      return reply.code(403).send(platformManagedResponse());
    }
    if (!platformManaged && !["owner", "admin"].includes(request.role)) {
      return reply.code(403).send(errorResponse("Requires role: owner or admin", 403));
    }
    if (!platformManaged) await shadowBillingManage(request.workspaceId, request.userId, "remove entitlement");
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));

    if (platformManaged) await changePlatformManaged(request, request.workspaceId, request.params.key, { remove: true });
    else await svc.remove(request.workspaceId, request.params.key);
    return reply.code(204).send();
  });

  // ── Platform admin: grant a platform-managed entitlement to any workspace ──────────────
  // Lets Skout staff open an internal release to a named workspace without being a member of
  // it. Platform admins only; only platform-managed keys; every change is audited.

  async function platformAdminTarget(
    request: FastifyRequest<{ Params: { workspaceId: string; key: string } }>,
    reply: FastifyReply
  ): Promise<boolean> {
    if (!request.userId) {
      reply.code(401).send(errorResponse("Unauthorized", 401));
      return false;
    }
    if (!isPlatformAdmin(app.config, request.userEmail)) {
      reply.code(403).send(errorResponse("Requires a platform admin", 403));
      return false;
    }
    if (!isPlatformManagedEntitlement(request.params.key)) {
      reply.code(400).send(errorResponse("Only platform-managed entitlements can be changed here", 400));
      return false;
    }
    if (!z.string().uuid().safeParse(request.params.workspaceId).success || !app.db || !service()) {
      reply.code(app.db ? 404 : 503).send(errorResponse(app.db ? "Workspace not found" : "Database unavailable", app.db ? 404 : 503));
      return false;
    }
    const [workspace] = await app.db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, request.params.workspaceId))
      .limit(1);
    if (!workspace) {
      reply.code(404).send(errorResponse("Workspace not found", 404));
      return false;
    }
    return true;
  }

  app.put<{ Params: { workspaceId: string; key: string } }>(
    "/admin/workspaces/:workspaceId/entitlements/:key",
    async (request, reply) => {
      if (!(await platformAdminTarget(request, reply))) return reply;
      const parsed = setSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send(errorResponse("Invalid entitlement payload", 400, parsed.error.flatten()));
      }
      const entitlement = await changePlatformManaged(request, request.params.workspaceId, request.params.key, { set: parsed.data.value });
      return reply.send({ data: entitlement });
    }
  );

  app.delete<{ Params: { workspaceId: string; key: string } }>(
    "/admin/workspaces/:workspaceId/entitlements/:key",
    async (request, reply) => {
      if (!(await platformAdminTarget(request, reply))) return reply;
      await changePlatformManaged(request, request.params.workspaceId, request.params.key, { remove: true });
      return reply.code(204).send();
    }
  );
}
