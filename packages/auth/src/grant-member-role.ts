import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";

type DbOrTx = Pick<Db, "select" | "insert">;

/**
 * §11.1 — mirror a new `workspace_members.role` into `workspace_member_roles` so the fine-grained
 * permission check (enforcePermission) sees the member. Every code path that inserts into
 * workspace_members must call this, otherwise the member holds a coarse role but zero permissions
 * and gets 403 on every enforced route once RBAC_ENFORCEMENT_ENABLED=true.
 *
 * Idempotent. Returns false (without throwing) when the system role isn't seeded yet, so a
 * pre-backfill environment can't break signup — the boot-time backfill guard covers that case.
 */
export async function grantSystemMemberRole(
  db: DbOrTx,
  workspaceId: string,
  userId: string,
  coarseRole: string
): Promise<boolean> {
  const [roleRow] = await db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(eq(schema.roles.key, coarseRole))
    .limit(1);
  if (!roleRow) return false;

  await db
    .insert(schema.workspaceMemberRoles)
    .values({ workspaceId, userId, roleId: roleRow.id })
    .onConflictDoNothing();
  return true;
}
