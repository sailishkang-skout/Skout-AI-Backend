import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDb } from "./client.js";
import { resolveDatabaseUrl } from "./database-url.js";
import { permissions, roles, rolePermissions, tenantWorkspaces, tenants, workspaceMemberRoles } from "./schema/tenancy.js";
import { workspaceMembers } from "./schema/users.js";
import { workspaces } from "./schema/workspaces.js";

/**
 * §5.1 (Enterprise Completion Plan) — Wave-1 backfill for the RBAC/tenancy tables added in
 * this pass. Safe to re-run (every insert is existence-checked or conflict-safe first):
 *   1. Seed the permission catalog and three system roles (owner/admin/member).
 *   2. Create a tenant + tenantWorkspaces row for every workspace that doesn't have one yet.
 *   3. For every workspace_members row, grant the matching system role via
 *      workspace_member_roles — mapping the existing flat `role` text column onto the new
 *      model without changing or removing that column.
 * This does NOT touch workspace_members.role, requireRole(), or any existing route — it is
 * purely additive. Run with: pnpm --filter @skout/db backfill-rbac
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {
  // ECS/task inject DATABASE_HOST + DATABASE_PASSWORD directly.
}

const PERMISSION_CATALOG: Array<{ key: string; description: string; category: string }> = [
  { key: "workspace:manage", description: "Manage workspace settings, integrations, and billing.", category: "workspace" },
  { key: "billing:manage", description: "View and change billing/subscription details.", category: "workspace" },
  { key: "team:manage", description: "Invite, remove, or change the role of workspace members.", category: "workspace" },
  { key: "sequences:manage", description: "Create, edit, and archive outreach sequences.", category: "outreach" },
  { key: "sequences:send", description: "Enroll prospects and trigger sends in an active sequence.", category: "outreach" },
  { key: "crm:manage", description: "Create and edit CRM records (companies, deals, contacts).", category: "crm" },
  { key: "automation:manage", description: "Create or modify activation rules and automations.", category: "automation" },
  { key: "identity:review_merges", description: "Approve or reject identity-merge proposals.", category: "data" },
  { key: "data:manage_retention", description: "Create and manage data-retention classification rules.", category: "data" },
];

const SYSTEM_ROLES: Array<{ key: string; name: string; description: string; permissionKeys: string[] }> = [
  {
    key: "owner",
    name: "Owner",
    description: "Full control of the workspace, including billing and team management.",
    permissionKeys: PERMISSION_CATALOG.map((p) => p.key),
  },
  {
    key: "admin",
    name: "Admin",
    description: "Manages team, automations, and day-to-day workspace operation. Cannot manage billing.",
    permissionKeys: PERMISSION_CATALOG.filter((p) => p.key !== "billing:manage").map((p) => p.key),
  },
  {
    key: "member",
    name: "Member",
    description: "Runs outreach and works CRM records. Cannot manage team, billing, or automations.",
    permissionKeys: ["sequences:send", "crm:manage"],
  },
];

const databaseUrl = resolveDatabaseUrl();
const { db, sql } = createDb(databaseUrl);

async function seedPermissionsAndRoles() {
  await db.insert(permissions).values(PERMISSION_CATALOG).onConflictDoNothing();
  console.log(`Permission catalog: ${PERMISSION_CATALOG.length} keys ensured.`);

  const roleIdByKey = new Map<string, string>();
  for (const roleDef of SYSTEM_ROLES) {
    const [existing] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.key, roleDef.key))
      .limit(1);

    let roleId = existing?.id;
    if (!roleId) {
      const [inserted] = await db
        .insert(roles)
        .values({ key: roleDef.key, name: roleDef.name, description: roleDef.description, isSystem: true, workspaceId: null })
        .returning({ id: roles.id });
      roleId = inserted.id;
      console.log(`Created system role "${roleDef.key}" (${roleId}).`);
    }
    roleIdByKey.set(roleDef.key, roleId);

    const grants = roleDef.permissionKeys.map((permissionKey) => ({ roleId, permissionKey }));
    if (grants.length) await db.insert(rolePermissions).values(grants).onConflictDoNothing();
  }
  return roleIdByKey;
}

async function backfillTenants() {
  const allWorkspaces = await db.select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug }).from(workspaces);
  let created = 0;
  for (const ws of allWorkspaces) {
    const [existing] = await db
      .select({ workspaceId: tenantWorkspaces.workspaceId })
      .from(tenantWorkspaces)
      .where(eq(tenantWorkspaces.workspaceId, ws.id))
      .limit(1);
    if (existing) continue;

    const [tenant] = await db.insert(tenants).values({ name: ws.name, slug: ws.slug }).returning({ id: tenants.id });
    await db.insert(tenantWorkspaces).values({ tenantId: tenant.id, workspaceId: ws.id }).onConflictDoNothing();
    created++;
  }
  console.log(`Tenants: ${created} created for workspaces without one (${allWorkspaces.length} workspaces total).`);
}

async function backfillMemberRoles(roleIdByKey: Map<string, string>) {
  const members = await db
    .select({ workspaceId: workspaceMembers.workspaceId, userId: workspaceMembers.userId, role: workspaceMembers.role })
    .from(workspaceMembers);

  let granted = 0;
  let skippedUnknownRole = 0;
  for (const member of members) {
    const roleId = roleIdByKey.get(member.role);
    if (!roleId) {
      skippedUnknownRole++;
      console.warn(`No system role matches workspace_members.role="${member.role}" for user ${member.userId} — skipped.`);
      continue;
    }
    const result = await db
      .insert(workspaceMemberRoles)
      .values({ workspaceId: member.workspaceId, userId: member.userId, roleId })
      .onConflictDoNothing()
      .returning({ workspaceId: workspaceMemberRoles.workspaceId });
    if (result.length) granted++;
  }
  console.log(`Member roles: ${granted} grants created (${members.length} workspace_members rows processed, ${skippedUnknownRole} skipped for unrecognized role values).`);
}

try {
  const roleIdByKey = await seedPermissionsAndRoles();
  await backfillTenants();
  await backfillMemberRoles(roleIdByKey);
  console.log("RBAC/tenancy backfill complete.");
} finally {
  await sql.end();
}
