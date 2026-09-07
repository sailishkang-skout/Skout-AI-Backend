import { index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { crmConnections } from "./integrations.js";
import { workspaces } from "./workspaces.js";

/** §8.12 Task ADI-10 — the two native-CRM entity types this sync engine covers so far. */
export const CRM_SYNC_ENTITY_TYPES = ["contact", "deal"] as const;
export type CrmSyncEntityType = (typeof CRM_SYNC_ENTITY_TYPES)[number];

/**
 * §8.12 Task ADI-10 — one row per (connection, entity type). `cursor` is the highest
 * provider-side "last modified" timestamp successfully processed so far; an incremental pull
 * reads from it and only advances it once the whole pull succeeds, so a run interrupted midway
 * leaves the checkpoint untouched and the next run resumes from the same point rather than
 * re-pulling everything (idempotent upserts downstream make re-processing the same window safe).
 */
export const crmSyncCheckpoints = pgTable(
  "crm_sync_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => crmConnections.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    cursor: timestamp("cursor", { withTimezone: true }),
    lastRunStatus: text("last_run_status").notNull().default("never_run"),
    lastRunStartedAt: timestamp("last_run_started_at", { withTimezone: true }),
    lastRunCompletedAt: timestamp("last_run_completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("crm_sync_checkpoints_connection_entity_uidx").on(table.connectionId, table.entityType),
    index("crm_sync_checkpoints_workspace_idx").on(table.workspaceId),
  ]
);

/**
 * §8.12 Task ADI-10 — maps a native Skout entity (contact/deal) to the provider-side record it
 * was pulled from or pushed to. `entityId` is polymorphic (contacts.id or deals.id depending on
 * `entityType`) — same no-FK pattern as tasks.relatedEntityId / incidents.relatedEntityId,
 * since a single column can't FK two different tables. `externalUpdatedAt` is refreshed on every
 * inbound pull from the provider's own last-modified property and is the source of truth the
 * outbound-write worker checks before pushing: if the provider's value changed more recently than
 * the Skout edit that queued the write, the write is skipped rather than overwriting it.
 */
export const crmNativeLinks = pgTable(
  "crm_native_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => crmConnections.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    externalId: text("external_id").notNull(),
    externalUpdatedAt: timestamp("external_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("crm_native_links_entity_uidx").on(table.connectionId, table.entityType, table.entityId),
    unique("crm_native_links_external_uidx").on(table.connectionId, table.entityType, table.externalId),
    index("crm_native_links_workspace_idx").on(table.workspaceId),
  ]
);

/**
 * §8.12 Task ADI-10 — outbound push-back queue, shaped as an `ExecutionIntentTable`
 * (packages/shared/src/execution-intent/) so the claim/lease/reclaim primitives already built for
 * §7.2 (see automation_run_steps for the reference adopter) work unmodified: `status`,
 * `leaseOwner`, `leaseExpiresAt`, `attemptCount`, `createdAt` are the required columns.
 * `skoutChangedAt` captures when the Skout-side edit that queued this write happened, so the
 * worker can compare it against crm_native_links.externalUpdatedAt at claim time — the reverse of
 * the inbound "manual wins" rule (see queueCrmOutboundWriteIfOwned in crm-outbound-sync.service.ts).
 */
export const crmOutboundWrites = pgTable(
  "crm_outbound_writes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => crmConnections.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    patch: jsonb("patch").notNull(),
    skoutChangedAt: timestamp("skout_changed_at", { withTimezone: true }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("crm_outbound_writes_idempotency_uidx").on(table.idempotencyKey),
    index("crm_outbound_writes_workspace_status_idx").on(table.workspaceId, table.status),
  ]
);
