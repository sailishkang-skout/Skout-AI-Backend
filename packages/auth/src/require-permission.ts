import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "./http.js";

const { workspaceMemberRoles, rolePermissions } = schema;

/**
 * §5.1 / §11.1 (Enterprise Completion Plan) — the opt-in Role/Permission check that consumes
 * the new `roles`/`permissions`/`role_permissions`/`workspace_member_roles` tables. This is
 * additive alongside requireRole.ts, which stays the enforced path for every existing route —
 * nothing here changes what requireRole() does or how `workspace_members.role` is checked.
 * New call sites (or existing ones migrating deliberately) opt into finer-grained permission
 * checks by calling this instead of/in addition to requireRole().
 *
 * Returns the member's granted permission keys for the workspace — checking `.includes(key)`
 * or using assertPermission() below for the throwing form.
 */
export async function getMemberPermissions(db: Db, workspaceId: string, userId: string): Promise<string[]> {
  const memberRoles = await db
    .select({ roleId: workspaceMemberRoles.roleId })
    .from(workspaceMemberRoles)
    .where(and(eq(workspaceMemberRoles.workspaceId, workspaceId), eq(workspaceMemberRoles.userId, userId)));

  if (memberRoles.length === 0) return [];

  const roleIds = memberRoles.map((r) => r.roleId);
  const grants = await db
    .select({ permissionKey: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(inArray(rolePermissions.roleId, roleIds));

  return [...new Set(grants.map((g) => g.permissionKey))];
}

/**
 * Throws 403 unless the member holds `permissionKey` in this workspace via the new
 * Role/Permission model. A member with zero rows in `workspace_member_roles` (i.e. not yet
 * backfilled, or backfill hasn't run in this environment) is denied, not silently allowed —
 * callers that need graceful degradation during rollout should catch this and fall back to
 * requireRole() explicitly, rather than this function failing open.
 */
export async function assertPermission(
  db: Db,
  workspaceId: string,
  userId: string,
  permissionKey: string
): Promise<void> {
  const granted = await getMemberPermissions(db, workspaceId, userId);
  if (!granted.includes(permissionKey)) {
    throw new HttpError("forbidden", 403, { requiredPermission: permissionKey });
  }
}
