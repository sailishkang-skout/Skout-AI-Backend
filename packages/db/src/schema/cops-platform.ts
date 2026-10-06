import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * COPS-01 — stored idempotency outcomes for Idempotency-Key requests (Bible p.81).
 * Primary key is (workspace, key). Rows expire after 24h; the reader treats an expired row as absent.
 */
export const copsIdempotencyKeys = pgTable(
  "cops_idempotency_keys",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    state: text("state").notNull().default("pending"),
    status: integer("status"),
    response: jsonb("response"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.key] }),
    index("cops_idempotency_expires_idx").on(table.expiresAt),
  ]
);

export const copsLifecycleStates = pgTable(
  "cops_lifecycle_states",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    dimension: text("dimension").notNull(),
    entityId: uuid("entity_id").notNull(),
    state: text("state").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.dimension, table.entityId] }),
    index("cops_lifecycle_workspace_dimension_idx").on(table.workspaceId, table.dimension),
  ]
);
