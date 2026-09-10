import { boolean, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
 * §11.1 / §16 / §5.1 Task 35 (Enterprise Completion Plan) — usage/plan entitlements. The
 * original Wave-1 doc comment here claimed "table + read/write API exist" — that was
 * aspirational, not accurate as of Task 35's audit: no service or route anywhere in the
 * codebase ever read or wrote this table before this pass (verified by grep across apps/ and
 * packages/). apps/api/src/services/entitlements.service.ts + entitlements.routes.ts (new)
 * are the real read/write API this comment always claimed to have.
 *
 * Migrating the existing per-feature workspace flags this table is meant to eventually replace
 * (credits, LinkedIn/WhatsApp send limits, calling) is explicitly flagged in this engagement's
 * own task list as the highest-risk item in this pass — it touches real money and live
 * customer-facing throughput limits. Task 35's actual scope is deliberately narrow and
 * additive-only: two call sites (LinkedIn/WhatsApp new-account dailySendLimit default in
 * linkedin-account.service.ts; per-workspace search credit cost in search.routes.ts) now read
 * an entitlement override when one exists and fall back to the exact pre-existing hardcoded/
 * config-driven value otherwise. Nothing about deductCredits() or the credit ledger itself
 * changed — only which number gets fed into those unchanged call sites when a workspace has
 * explicitly been given an override via the new PUT /entitlements/:key route (owner/admin
 * only). A workspace with zero entitlements rows behaves byte-for-byte as it did before this
 * commit. Migrating "calling" has no existing flag to migrate from — nothing in this codebase
 * enforces a calling limit today — so that one is left as a real, disclosed gap, not attempted.
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
  (table) => [
    // Task 35: was a plain (non-unique) index — upgraded to unique so set()'s upsert
    // (onConflictDoUpdate) has a real target and two concurrent writers can't create
    // duplicate (workspaceId, key) rows. See 0055_entitlements_unique.sql for the migration,
    // which defensively dedupes any pre-existing duplicates before creating the index.
    uniqueIndex("entitlements_workspace_key_idx").on(table.workspaceId, table.key),
  ]
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

/**
 * §11.1 Stage-6 — per-customer SSO IdP binding for a workspace (Clerk org + connection).
 * Metadata exchange still happens in Clerk Dashboard; this row is the durable Skout record
 * that product/ops activate at deal time.
 */
export const workspaceSsoConfigs = pgTable("workspace_sso_configs", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  clerkOrgId: text("clerk_org_id").notNull(),
  idpProvider: text("idp_provider").notNull().default("okta"),
  idpConnectionId: text("idp_connection_id"),
  idpMetadataUrl: text("idp_metadata_url"),
  scimEnabled: boolean("scim_enabled").notNull().default(false),
  groupRoleMap: jsonb("group_role_map")
    .notNull()
    .default({ Owners: "owner", Admins: "admin", Members: "member" }),
  status: text("status").notNull().default("pending"), // pending | active | disabled
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  activatedBy: uuid("activated_by").references(() => users.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
