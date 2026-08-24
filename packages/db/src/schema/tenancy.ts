import { boolean, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * §5.1 (Enterprise Completion Plan) — Tenant as a first-class entity distinct from Workspace.
 * Additive only: no column on `workspaces` changes. A tenant owns workspaces through
 * `tenantWorkspaces` below rather than a direct FK, so this ships without touching the
 * existing `workspaces` table at all — the safest shape for a schema change that has to run
 * against a database with real customer data on it. Backfilled 1:1 (one tenant per existing
 * workspace) by backfill-rbac.ts; a tenant owning multiple workspaces later needs no further
 * migration, only new rows in tenantWorkspaces.
 */
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tenantWorkspaces = pgTable(
  "tenant_workspaces",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .unique()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.workspaceId] })]
);

/**
 * §5.1 / §11.1 — Role/Permission/Entitlement model. Additive alongside the existing
 * `workspace_members.role` text column (owner/admin/member) — requireRole() and that column
 * are untouched and remain the enforced path everywhere they're already used. This is the
 * opt-in Wave-1 layer new call sites can build on (see requirePermission.ts in packages/auth);
 * migrating every existing requireRole() call site onto it is tracked, separate follow-up
 * work, not silently implied as done by this migration existing.
 */
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null = system role, available to every workspace. Non-null = a workspace's own custom role. */
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("roles_workspace_id_idx").on(table.workspaceId)]
);

export const permissions = pgTable("permissions", {
  /** e.g. "sequences:send", "billing:manage" — the permission catalog, seeded once by backfill-rbac.ts. */
  key: text("key").primaryKey(),
  description: text("description").notNull(),
  category: text("category").notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permissions.key, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionKey] })]
);

/**
 * A member can hold zero or more roles per workspace. Populated by backfill-rbac.ts from the
 * existing `workspace_members.role` column; kept in sync going forward by requirePermission.ts
 * wherever a caller opts into the new model.
 */
export const workspaceMemberRoles = pgTable(
  "workspace_member_roles",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId, table.roleId] }),
    index("workspace_member_roles_workspace_user_idx").on(table.workspaceId, table.userId),
  ]
);

/**
 * §11.1 / §16 — usage/plan entitlements. Wave 1: table + read/write API exist. Migrating the
 * existing per-feature workspace flags this is meant to replace (credits, LinkedIn send
 * limits, calling) onto it is separate, tracked follow-up work — not done in this pass.
 */
export const entitlements = pgTable(
  "entitlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** Free-form — boolean flag, numeric limit, or structured config, depending on `key`. */
    value: jsonb("value").notNull(),
    source: text("source").notNull().default("manual"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("entitlements_workspace_key_idx").on(table.workspaceId, table.key)]
);

/**
 * §5.1 / §11.1 — consent records. Scoped to a workspace + an arbitrary subject
 * (entityType/entityId) rather than only users, since most consent in this product concerns a
 * prospect/contact, not a Skout user account.
 */
export const consents = pgTable(
  "consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    type: text("type").notNull(),
    basis: text("basis").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [index("consents_workspace_subject_idx").on(table.workspaceId, table.subjectType, table.subjectId)]
);
