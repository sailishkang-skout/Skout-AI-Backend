import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { writeCopsAudit } from "./cops-platform.service.js";

/**
 * COPS-14 part C, first slice (docs/tickets/copos-14-audit.md): custom roles over the COPS-01
 * verbs, and member role grants.
 *
 * - Base roles (owner, admin, member) mirror workspace_members.role and stay owned by the team
 *   settings; they are never granted, edited or removed here.
 * - System roles (the CustomerOps roles, workspace_id NULL) can be granted but not edited.
 * - Custom roles belong to one workspace and only use keys from the permission catalog.
 * - No privilege escalation: the caller cannot put a permission they do not hold into a role, or
 *   grant a role that has one.
 * - Every change is audited with before/after; changes that alter access need a reason.
 */
const { roles, permissions, rolePermissions, workspaceMemberRoles, workspaceMembers } = schema;

export const BASE_ROLE_KEYS = ["owner", "admin", "member"] as const;
const isBase = (key: string) => (BASE_ROLE_KEYS as readonly string[]).includes(key);

export class RoleError extends Error {
  constructor(
    public code: "NOT_FOUND" | "FORBIDDEN" | "BUSINESS_STATE_CONFLICT" | "VALIDATION_FAILED",
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
  }
  get status() {
    return { NOT_FOUND: 404, FORBIDDEN: 403, BUSINESS_STATE_CONFLICT: 409, VALIDATION_FAILED: 422 }[this.code];
  }
}

export interface RoleCtx {
  workspaceId: string;
  userId: string;
  requestId: string;
  /** The caller's own permission keys, for the escalation check. */
  permissions: string[];
}

type RoleRow = typeof roles.$inferSelect;
const kindOf = (r: RoleRow): "base" | "system" | "custom" => (r.workspaceId ? "custom" : isBase(r.key) ? "base" : "system");

/** Roles visible in a workspace: every system role and this workspace's custom roles. */
const visible = (workspaceId: string) => or(isNull(roles.workspaceId), eq(roles.workspaceId, workspaceId))!;

async function roleDtos(db: Db, workspaceId: string, rows: RoleRow[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const grants = await db.select().from(rolePermissions).where(inArray(rolePermissions.roleId, ids));
  const counts = await db
    .select({ roleId: workspaceMemberRoles.roleId, n: sql<number>`count(*)::int` })
    .from(workspaceMemberRoles)
    .where(and(eq(workspaceMemberRoles.workspaceId, workspaceId), inArray(workspaceMemberRoles.roleId, ids)))
    .groupBy(workspaceMemberRoles.roleId);
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    kind: kindOf(r),
    editable: kindOf(r) === "custom",
    permission_keys: grants.filter((g) => g.roleId === r.id).map((g) => g.permissionKey).sort(),
    member_count: counts.find((c) => c.roleId === r.id)?.n ?? 0,
  }));
}

export async function listPermissionCatalog(db: Db) {
  return db.select().from(permissions).orderBy(asc(permissions.category), asc(permissions.key));
}

export async function listRoles(db: Db, workspaceId: string) {
  const rows = await db.select().from(roles).where(visible(workspaceId)).orderBy(asc(roles.workspaceId), asc(roles.name));
  // Base first, then CustomerOps system roles, then custom.
  const order = { base: 0, system: 1, custom: 2 } as const;
  return (await roleDtos(db, workspaceId, rows)).sort((a, b) => order[a.kind] - order[b.kind]);
}

async function loadRole(db: Db, workspaceId: string, id: string) {
  const [row] = await db.select().from(roles).where(and(eq(roles.id, id), visible(workspaceId))).limit(1);
  if (!row) throw new RoleError("NOT_FOUND", "Role not found");
  return row;
}

async function permissionsOf(db: Db, roleIds: string[]) {
  if (roleIds.length === 0) return [];
  const rows = await db.select({ key: rolePermissions.permissionKey }).from(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
  return [...new Set(rows.map((r) => r.key))].sort();
}

/** Unknown keys are a validation error; keys the caller lacks are an escalation. */
async function checkKeys(db: Db, ctx: RoleCtx, keys: string[]) {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return unique;
  const known = await db.select({ key: permissions.key }).from(permissions).where(inArray(permissions.key, unique));
  const unknown = unique.filter((k) => !known.some((r) => r.key === k));
  if (unknown.length) throw new RoleError("VALIDATION_FAILED", "Unknown permission keys", { unknown });
  const missing = unique.filter((k) => !ctx.permissions.includes(k));
  if (missing.length) throw new RoleError("FORBIDDEN", "You cannot grant permissions you do not hold", { missing });
  return unique.sort();
}

async function nameTaken(db: Db, workspaceId: string, name: string, exceptId?: string) {
  const [row] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.workspaceId, workspaceId), sql`lower(${roles.name}) = lower(${name})`))
    .limit(1);
  return Boolean(row && row.id !== exceptId);
}

const audit = (tx: Db, ctx: RoleCtx, entityType: string, entityId: string, action: string, before: unknown, after: unknown, reason: string | null) =>
  writeCopsAudit(tx, {
    tenantId: ctx.workspaceId,
    actor: { type: "user", id: ctx.userId },
    entityType,
    entityId,
    action,
    before,
    after,
    reason,
    correlationId: ctx.requestId,
    sourceChannel: "web",
  });

export async function createRole(db: Db, ctx: RoleCtx, input: { name: string; description?: string; permission_keys?: string[]; clone_from_role_id?: string }) {
  const name = input.name.trim();
  let keys = input.permission_keys;
  if (!keys && input.clone_from_role_id) {
    const source = await loadRole(db, ctx.workspaceId, input.clone_from_role_id);
    keys = await permissionsOf(db, [source.id]);
  }
  const checked = await checkKeys(db, ctx, keys ?? []);
  if (await nameTaken(db, ctx.workspaceId, name)) throw new RoleError("BUSINESS_STATE_CONFLICT", "A custom role with this name already exists");
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(roles)
      .values({ workspaceId: ctx.workspaceId, key: `custom_${randomUUID().slice(0, 8)}`, name, description: input.description?.trim() || null, isSystem: false })
      .returning();
    if (checked.length) await tx.insert(rolePermissions).values(checked.map((permissionKey) => ({ roleId: row!.id, permissionKey })));
    await audit(tx as never, ctx, "role", row!.id, "role.created", null, { name, permission_keys: checked, cloned_from: input.clone_from_role_id ?? null }, null);
    return row!.id;
  });
  return (await roleDtos(db, ctx.workspaceId, [await loadRole(db, ctx.workspaceId, id)]))[0]!;
}

async function loadCustom(db: Db, ctx: RoleCtx, id: string) {
  const row = await loadRole(db, ctx.workspaceId, id);
  if (kindOf(row) !== "custom") throw new RoleError("BUSINESS_STATE_CONFLICT", `A ${kindOf(row)} role cannot be changed here`, { kind: kindOf(row) });
  return row;
}

export async function updateRole(db: Db, ctx: RoleCtx, id: string, input: { name?: string; description?: string; permission_keys?: string[]; reason: string }) {
  const row = await loadCustom(db, ctx, id);
  const beforeKeys = await permissionsOf(db, [row.id]);
  const keys = input.permission_keys ? await checkKeys(db, ctx, input.permission_keys) : beforeKeys;
  const name = input.name?.trim() ?? row.name;
  if (name !== row.name && (await nameTaken(db, ctx.workspaceId, name, row.id))) throw new RoleError("BUSINESS_STATE_CONFLICT", "A custom role with this name already exists");
  await db.transaction(async (tx) => {
    await tx.update(roles).set({ name, description: input.description !== undefined ? input.description.trim() || null : row.description }).where(eq(roles.id, row.id));
    if (input.permission_keys) {
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, row.id));
      if (keys.length) await tx.insert(rolePermissions).values(keys.map((permissionKey) => ({ roleId: row.id, permissionKey })));
    }
    await audit(tx as never, ctx, "role", row.id, "role.updated", { name: row.name, permission_keys: beforeKeys }, { name, permission_keys: keys }, input.reason.trim());
  });
  return (await roleDtos(db, ctx.workspaceId, [await loadRole(db, ctx.workspaceId, id)]))[0]!;
}

export async function deleteRole(db: Db, ctx: RoleCtx, id: string, reason: string) {
  const row = await loadCustom(db, ctx, id);
  const [held] = await db.select({ n: sql<number>`count(*)::int` }).from(workspaceMemberRoles).where(eq(workspaceMemberRoles.roleId, row.id));
  if ((held?.n ?? 0) > 0) throw new RoleError("BUSINESS_STATE_CONFLICT", "Members still hold this role; remove it from them first", { member_count: held!.n });
  const beforeKeys = await permissionsOf(db, [row.id]);
  await db.transaction(async (tx) => {
    await tx.delete(roles).where(eq(roles.id, row.id));
    await audit(tx as never, ctx, "role", row.id, "role.deleted", { name: row.name, permission_keys: beforeKeys }, null, reason.trim());
  });
  return { id: row.id, deleted: true };
}

async function assertMember(db: Db, workspaceId: string, userId: string) {
  const [m] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  if (!m) throw new RoleError("NOT_FOUND", "Not a member of this workspace");
}

export async function getMemberRoles(db: Db, workspaceId: string, userId: string) {
  await assertMember(db, workspaceId, userId);
  const held = await db
    .select({ role: roles })
    .from(workspaceMemberRoles)
    .innerJoin(roles, eq(roles.id, workspaceMemberRoles.roleId))
    .where(and(eq(workspaceMemberRoles.workspaceId, workspaceId), eq(workspaceMemberRoles.userId, userId)));
  const rows = held.map((h) => h.role);
  return { user_id: userId, roles: await roleDtos(db, workspaceId, rows), permissions: await permissionsOf(db, rows.map((r) => r.id)) };
}

/** Replaces a member's system and custom roles. The base role is kept as it is. */
export async function setMemberRoles(db: Db, ctx: RoleCtx, userId: string, roleIds: string[], reason: string) {
  await assertMember(db, ctx.workspaceId, userId);
  const wanted = [...new Set(roleIds)];
  const rows = wanted.length ? await db.select().from(roles).where(and(inArray(roles.id, wanted), visible(ctx.workspaceId))) : [];
  const missing = wanted.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) throw new RoleError("NOT_FOUND", "Some roles are not available in this workspace", { role_ids: missing });
  const base = rows.filter((r) => isBase(r.key));
  if (base.length) throw new RoleError("VALIDATION_FAILED", "The owner, admin and member roles are set in team settings", { role_ids: base.map((r) => r.id) });
  const granted = await permissionsOf(db, wanted);
  const escalation = granted.filter((k) => !ctx.permissions.includes(k));
  if (escalation.length) throw new RoleError("FORBIDDEN", "You cannot grant a role with permissions you do not hold", { missing: escalation });

  const before = await getMemberRoles(db, ctx.workspaceId, userId);
  const keptBaseKeys = before.roles.filter((r) => r.kind === "base").map((r) => r.key);
  await db.transaction(async (tx) => {
    const removable = before.roles.filter((r) => r.kind !== "base").map((r) => r.id);
    if (removable.length) {
      await tx
        .delete(workspaceMemberRoles)
        .where(and(eq(workspaceMemberRoles.workspaceId, ctx.workspaceId), eq(workspaceMemberRoles.userId, userId), inArray(workspaceMemberRoles.roleId, removable)));
    }
    if (wanted.length) {
      await tx.insert(workspaceMemberRoles).values(wanted.map((roleId) => ({ workspaceId: ctx.workspaceId, userId, roleId, grantedBy: ctx.userId }))).onConflictDoNothing();
    }
    await audit(
      tx as never,
      ctx,
      "workspace_member",
      userId,
      "member.roles_updated",
      { role_keys: before.roles.map((r) => r.key).sort(), permissions: before.permissions },
      { role_keys: [...keptBaseKeys, ...rows.map((r) => r.key)].sort(), permissions: await permissionsOf(tx as never, [...before.roles.filter((r) => r.kind === "base").map((r) => r.id), ...wanted]) },
      reason.trim()
    );
  });
  return getMemberRoles(db, ctx.workspaceId, userId);
}
