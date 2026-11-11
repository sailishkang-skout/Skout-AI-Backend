import type { FastifyReply, FastifyRequest } from "fastify";
import { schema, type Db } from "@skout/db";
import { and, eq, isNull } from "drizzle-orm";
import { getMemberPermissions } from "@skout/auth";
import { copsErrorBody, resolveCorrelationId } from "@skout/shared";
import type { Env } from "../config/env.js";

/**
 * COPS-15: the CustomerOps portal is for Skout staff only. A caller may use a CustomerOps route
 * when they are a member of the internal workspace (INTERNAL_WORKSPACE_ID) AND hold ops:access,
 * which no role gets automatically. Anyone else gets 403, never an empty 200.
 */
export const OPS_ACCESS = "ops:access";
export const OPS_ACCESS_ROLE_KEY = "ops_access";

export interface OpsAccessState {
  /** The caller may use CustomerOps. */
  allowed: boolean;
  /** The guard refuses (true) or only logs (shadow mode). */
  enforced: boolean;
  internalWorkspace: boolean;
  hasPermission: boolean;
}

type OpsAccessConfig = Pick<Env, "INTERNAL_WORKSPACE_ID" | "OPS_ACCESS_ENFORCED">;

/**
 * Whether the guard refuses: on as soon as INTERNAL_WORKSPACE_ID is set (the one setting COPS-15
 * needs). OPS_ACCESS_ENFORCED is only an emergency switch: "false" drops back to logging only.
 */
export function opsAccessEnforced(config: Pick<Env, "INTERNAL_WORKSPACE_ID" | "OPS_ACCESS_ENFORCED">): boolean {
  if (config.OPS_ACCESS_ENFORCED === "false") return false;
  return config.OPS_ACCESS_ENFORCED === "true" || !!config.INTERNAL_WORKSPACE_ID;
}

export async function opsAccessState(db: Db, config: OpsAccessConfig, workspaceId: string, userId: string): Promise<OpsAccessState> {
  const internalWorkspace = !!config.INTERNAL_WORKSPACE_ID && workspaceId === config.INTERNAL_WORKSPACE_ID;
  const hasPermission = (await getMemberPermissions(db, workspaceId, userId)).includes(OPS_ACCESS);
  return { allowed: internalWorkspace && hasPermission, enforced: opsAccessEnforced(config), internalWorkspace, hasPermission };
}

/**
 * First rollout: while nobody in the internal workspace holds Ops access yet, every member gets it
 * once (audited), so the guard can enforce from day one without locking staff out. After that it
 * does nothing: new staff get Ops access through an invite or People, and a removal is never undone.
 * Returns how many members were granted.
 */
export async function bootstrapOpsAccess(db: Db, config: Pick<Env, "INTERNAL_WORKSPACE_ID">): Promise<number> {
  const ws = config.INTERNAL_WORKSPACE_ID;
  if (!ws) return 0;
  const [opsRole] = await db.select({ id: schema.roles.id }).from(schema.roles).where(and(isNull(schema.roles.workspaceId), eq(schema.roles.key, OPS_ACCESS_ROLE_KEY))).limit(1);
  if (!opsRole) return 0;
  const [anyHolder] = await db
    .select({ userId: schema.workspaceMemberRoles.userId })
    .from(schema.workspaceMemberRoles)
    .where(and(eq(schema.workspaceMemberRoles.workspaceId, ws), eq(schema.workspaceMemberRoles.roleId, opsRole.id)))
    .limit(1);
  // Ever granted (even if since removed from some) = past the first rollout: never grant again.
  const [everGranted] = await db
    .select({ id: schema.auditLogs.id })
    .from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.workspaceId, ws), eq(schema.auditLogs.action, "ops_access.granted")))
    .limit(1);
  if (anyHolder || everGranted) return 0;
  const members = await db.select({ userId: schema.workspaceMembers.userId }).from(schema.workspaceMembers).where(eq(schema.workspaceMembers.workspaceId, ws));
  for (const m of members) {
    await db.insert(schema.workspaceMemberRoles).values({ workspaceId: ws, userId: m.userId, roleId: opsRole.id }).onConflictDoNothing();
    await db.insert(schema.auditLogs).values({ workspaceId: ws, actorId: null, actorType: "system", action: "ops_access.granted", entityType: "workspace_member", entityId: m.userId, afterState: { via: "first_rollout" } } as never);
  }
  return members.length;
}

/**
 * preHandler for every CustomerOps route. Public routes in the same plugins (provider webhooks,
 * signed document links) are skipped: they authenticate by signature, not by a staff session.
 */
export function opsAccessGuard(db: Db, config: OpsAccessConfig, isPublic: (url: string, method?: string) => boolean) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (isPublic(request.url, request.method)) return;
    if (!request.workspaceId || !request.userId) return; // the auth plugin has already answered 401
    const state = await opsAccessState(db, config, request.workspaceId, request.userId);
    if (state.allowed) return;
    const why = !config.INTERNAL_WORKSPACE_ID ? "internal workspace not configured" : !state.internalWorkspace ? "not the internal workspace" : "no ops:access";
    if (!state.enforced) {
      request.log.warn({ workspaceId: request.workspaceId, userId: request.userId, url: request.url, why }, "ops:access shadow-mode: this CustomerOps request would be refused");
      return;
    }
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    return reply.status(403).send(copsErrorBody({ code: "FORBIDDEN", message: "CustomerOps is only for Skout staff with Ops access. Ask your Admin.", requestId }));
  };
}

/**
 * COPS-15: an invite sent from the ops portal with Ops access grants the Ops access role when it
 * is accepted, whichever accept path runs (team API or the invite code/password flow). Audited.
 */
export async function grantOpsAccessFromInvite(db: Db, invite: { id: string; workspaceId: string; grantOpsAccess?: boolean | null }, userId: string): Promise<void> {
  if (!invite.grantOpsAccess) return;
  const [opsRole] = await db.select({ id: schema.roles.id }).from(schema.roles).where(and(isNull(schema.roles.workspaceId), eq(schema.roles.key, OPS_ACCESS_ROLE_KEY))).limit(1);
  if (!opsRole) return;
  await db.insert(schema.workspaceMemberRoles).values({ workspaceId: invite.workspaceId, userId, roleId: opsRole.id }).onConflictDoNothing();
  await db.insert(schema.auditLogs).values({ workspaceId: invite.workspaceId, actorId: userId, actorType: "user", action: "ops_access.granted", entityType: "workspace_member", entityId: userId, afterState: { via: "invite", invite_id: invite.id } } as never);
}
