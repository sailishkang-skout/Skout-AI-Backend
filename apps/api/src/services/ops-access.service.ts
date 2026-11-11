import type { FastifyReply, FastifyRequest } from "fastify";
import { schema, type Db } from "@skout/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
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

type OpsAccessConfig = Pick<Env, "INTERNAL_WORKSPACE_ID" | "OPS_ACCESS_ENFORCED"> & { NODE_ENV?: Env["NODE_ENV"] };

/**
 * Whether the guard refuses. Production always does (no setting needed); OPS_ACCESS_ENFORCED=false is
 * an emergency switch only. Elsewhere (local, tests) it refuses when INTERNAL_WORKSPACE_ID or
 * OPS_ACCESS_ENFORCED=true is set, and otherwise only logs.
 */
export function opsAccessEnforced(config: Pick<Env, "INTERNAL_WORKSPACE_ID" | "OPS_ACCESS_ENFORCED"> & { NODE_ENV?: Env["NODE_ENV"] }): boolean {
  if (config.OPS_ACCESS_ENFORCED === "false") return false;
  return config.OPS_ACCESS_ENFORCED === "true" || config.NODE_ENV === "production" || !!config.INTERNAL_WORKSPACE_ID;
}

/**
 * Chain of trust: the Skout workspace is INTERNAL_WORKSPACE_ID when it is set, otherwise the workspace
 * whose members hold Ops access. Only a holder can grant it (canGrantOpsAccess), so a customer
 * workspace never gets its first holder; the first ones come from migration 0152 or the first start.
 */
export async function isInternalWorkspace(db: Db, config: Pick<Env, "INTERNAL_WORKSPACE_ID">, workspaceId: string): Promise<boolean> {
  if (config.INTERNAL_WORKSPACE_ID) return workspaceId === config.INTERNAL_WORKSPACE_ID;
  const [holder] = await db
    .select({ userId: schema.workspaceMemberRoles.userId })
    .from(schema.workspaceMemberRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.workspaceMemberRoles.roleId))
    .where(and(eq(schema.workspaceMemberRoles.workspaceId, workspaceId), isNull(schema.roles.workspaceId), eq(schema.roles.key, OPS_ACCESS_ROLE_KEY)))
    .limit(1);
  return !!holder;
}

/** True when anyone, in any workspace, holds Ops access (the chain of trust has a start). */
export async function anyOpsAccessHolder(db: Db): Promise<boolean> {
  const [holder] = await db
    .select({ userId: schema.workspaceMemberRoles.userId })
    .from(schema.workspaceMemberRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.workspaceMemberRoles.roleId))
    .where(and(isNull(schema.roles.workspaceId), eq(schema.roles.key, OPS_ACCESS_ROLE_KEY)))
    .limit(1);
  return !!holder;
}

/** Who may give Ops access (invite with it, or tick it in People): an Owner or Admin who holds it. */
export async function canGrantOpsAccess(db: Db, config: Pick<Env, "INTERNAL_WORKSPACE_ID">, workspaceId: string, userId: string, workspaceRole: string): Promise<boolean> {
  if (!["owner", "admin"].includes(workspaceRole)) return false;
  if (!(await isInternalWorkspace(db, config, workspaceId))) return false;
  return (await getMemberPermissions(db, workspaceId, userId)).includes(OPS_ACCESS);
}

export async function opsAccessState(db: Db, config: OpsAccessConfig, workspaceId: string, userId: string): Promise<OpsAccessState> {
  const read = async () => {
    const internalWorkspace = await isInternalWorkspace(db, config, workspaceId);
    const hasPermission = (await getMemberPermissions(db, workspaceId, userId)).includes(OPS_ACCESS);
    return { allowed: internalWorkspace && hasPermission, enforced: opsAccessEnforced(config), internalWorkspace, hasPermission };
  };
  const state = await read();
  if (state.allowed || config.INTERNAL_WORKSPACE_ID) return state;
  return (await claimFirstOpsAccess(db, workspaceId, userId)) ? read() : state;
}

/** Skout staff sign in with a Skout work email (the ops portal only lets this domain in, too). */
export const SKOUT_STAFF_EMAIL_DOMAIN = "skoutai.io";

/**
 * The very first holder, when nobody has ever been given Ops access (a new environment where
 * migration 0152 found no Skout workspace): the first workspace Owner with a verified
 * @skoutai.io email who signs in gets it, audited `first_owner`. A customer cannot: their email is
 * not a Skout one. Once anyone has ever held it, this never grants again; from then on only a
 * holder gives it (invite or People).
 */
export async function claimFirstOpsAccess(db: Db, workspaceId: string, userId: string): Promise<boolean> {
  const [member] = await db
    .select({ role: schema.workspaceMembers.role, email: schema.users.email })
    .from(schema.workspaceMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)))
    .limit(1);
  const email = member?.email.trim().toLowerCase() ?? "";
  if (member?.role !== "owner" || !email.endsWith(`@${SKOUT_STAFF_EMAIL_DOMAIN}`)) return false;
  const [verified] = await db
    .select({ id: schema.authIdentities.id })
    .from(schema.authIdentities)
    .where(and(eq(schema.authIdentities.userId, userId), isNotNull(schema.authIdentities.emailVerifiedAt), sql`lower(${schema.authIdentities.emailAtLink}) = ${email}`))
    .limit(1);
  if (!verified) return false;
  return db.transaction(async (tx) => {
    // One claim at a time, so two Owners signing in together cannot both become first.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ops_access.first_owner'))`);
    const [opsRole] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(and(isNull(schema.roles.workspaceId), eq(schema.roles.key, OPS_ACCESS_ROLE_KEY))).limit(1);
    if (!opsRole) return false;
    const [holder] = await tx.select({ userId: schema.workspaceMemberRoles.userId }).from(schema.workspaceMemberRoles).where(eq(schema.workspaceMemberRoles.roleId, opsRole.id)).limit(1);
    const [everGranted] = await tx.select({ id: schema.auditLogs.id }).from(schema.auditLogs).where(eq(schema.auditLogs.action, "ops_access.granted")).limit(1);
    if (holder || everGranted) return false;
    await tx.insert(schema.workspaceMemberRoles).values({ workspaceId, userId, roleId: opsRole.id }).onConflictDoNothing();
    await tx.insert(schema.auditLogs).values({ workspaceId, actorId: userId, actorType: "user", action: "ops_access.granted", entityType: "workspace_member", entityId: userId, afterState: { via: "first_owner" } } as never);
    return true;
  });
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
    const why = !state.internalWorkspace ? "not the Skout workspace" : "no ops:access";
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
