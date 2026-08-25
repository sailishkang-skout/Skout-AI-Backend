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

export interface EnforcePermissionOptions {
  /**
   * Wire this to `config.RBAC_ENFORCEMENT_ENABLED` (default false in every env schema this is
   * used from). Real users currently have zero `workspace_member_roles` rows in every
   * environment this session can reach, because `backfill-rbac.ts` has never been run against a
   * real Postgres from here — turning this on before that backfill runs would deny every request
   * outright (assertPermission fails closed). This flag exists so call sites can be wired in now
   * without that risk: enforced only once an operator has run the backfill and flips the flag.
   */
  enforce: boolean;
  /**
   * Called when enforce=false and the permission would have been denied — wire this to your
   * app's logger. Without it, shadow-mode denials are invisible, which defeats the point of
   * running in shadow mode before flipping enforcement on.
   */
  onShadowDeny?: (info: { workspaceId: string; userId: string; permissionKey: string }) => void;
}

/**
 * §5.1 / §11.1 (Enterprise Completion Plan) — the safe-rollout wrapper for assertPermission.
 * Call sites use this instead of assertPermission() directly wherever the surrounding route
 * already has a coarser guard (e.g. requireRole(["owner","admin"])) that keeps behavior
 * unchanged today. With enforce=false (the default everywhere until an operator opts in per
 * environment), a denial is reported via onShadowDeny instead of thrown, so the fine-grained
 * permission model can be observed against real traffic before it's allowed to actually block
 * anything. With enforce=true, behaves exactly like assertPermission (throws 403).
 */
export async function enforcePermission(
  db: Db,
  workspaceId: string,
  userId: string,
  permissionKey: string,
  options: EnforcePermissionOptions
): Promise<void> {
  const granted = await getMemberPermissions(db, workspaceId, userId);
  if (granted.includes(permissionKey)) return;

  if (options.enforce) {
    throw new HttpError("forbidden", 403, { requiredPermission: permissionKey });
  }
  options.onShadowDeny?.({ workspaceId, userId, permissionKey });
}

/**
 * §11.1 — refuse RBAC_ENFORCEMENT_ENABLED=true when workspace_member_roles is empty
 * (backfill never run). Prevents locking every user out at boot.
 */
export async function assertRbacBackfillReady(db: Db): Promise<{ ready: boolean; sampleGrantExists: boolean }> {
  const [row] = await db.select({ userId: workspaceMemberRoles.userId }).from(workspaceMemberRoles).limit(1);
  const sampleGrantExists = Boolean(row);
  return { ready: sampleGrantExists, sampleGrantExists };
}
