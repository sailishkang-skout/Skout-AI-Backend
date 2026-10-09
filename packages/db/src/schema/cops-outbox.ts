import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * COPS-01 — transactional outbox (ADR 0017, Bible p.72).
 *
 * A row is written in the same DB transaction as the state change that produced the event, so a
 * commit and its event can never diverge. A relay worker reads rows where `published_at` is null,
 * publishes them through BullMQ on the existing Redis, and stamps `published_at`. Failures retry
 * with backoff until `attempts` reaches the limit, then the row stays with `dead_lettered_at` set
 * for replay.
 *
 * `id` is the envelope's `event_id`, so a duplicate insert of the same event fails on the primary
 * key instead of creating a second effect.
 */
export const copsOutbox = pgTable(
  "cops_outbox",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    /** Full validated envelope (see packages/shared/src/copos-events.ts). Stored as-is for replay. */
    envelope: jsonb("envelope").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("cops_outbox_pending_idx").on(table.nextAttemptAt).where(sql`published_at is null and dead_lettered_at is null`),
    index("cops_outbox_tenant_created_idx").on(table.tenantId, table.createdAt),
  ]
);

/**
 * COPS-01 — idempotent consumer log. A consumer records `(consumer, event_id)` in the same
 * transaction as its side effect; a second delivery of the same event hits the primary key and is
 * a no-op.
 */
export const copsProcessedEvents = pgTable(
  "cops_processed_events",
  {
    consumer: text("consumer").notNull(),
    eventId: uuid("event_id").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.consumer, table.eventId] })]
);
