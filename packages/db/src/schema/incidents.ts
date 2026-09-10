import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * §5.1 Core entities (Wave 2, now shipped) — Incident, the operational counterpart to
 * §11.3's "anomaly detection on silent pipeline breaks, provider degradation and model drift."
 * A row here is the durable record an alert (Sentry, Datadog, a future OTel-based anomaly
 * detector) resolves into — something a human can see, own, and close, not just a transient
 * notification. Workspace-scoped since most sources are workspace-specific (a provider outage
 * affecting one workspace's enrichment run); a platform-wide incident uses a sentinel/null
 * pattern consistent with `roles.workspaceId` (nullable = system-level) if one is ever needed —
 * not built here since no cross-workspace incident source exists yet.
 */
export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** low | medium | high | critical — plain text, matching this schema's existing convention. */
    severity: text("severity").notNull().default("medium"),
    /** open | investigating | resolved */
    status: text("status").notNull().default("open"),
    /** Free text identifying what detected/reported this — e.g. "warmup-tool",
     * "sequence-runtime", "provider:hunter", "manual". Not an FK: sources span services and
     * sometimes aren't a Skout entity at all (a provider's own status page). */
    source: text("source").notNull(),
    description: text("description"),
    relatedEntityType: text("related_entity_type"),
    relatedEntityId: uuid("related_entity_id"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolutionNotes: text("resolution_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("incidents_workspace_id_idx").on(table.workspaceId),
    index("incidents_workspace_status_idx").on(table.workspaceId, table.status),
    index("incidents_workspace_entity_idx").on(table.workspaceId, table.relatedEntityType, table.relatedEntityId),
  ]
);
