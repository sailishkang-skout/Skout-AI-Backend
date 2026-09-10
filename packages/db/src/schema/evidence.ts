import { index, integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * §5.3 (Enterprise Completion Plan) — the canonical Evidence Ledger.
 *
 * Wave 2 (2026-08-26): evidence_ledger is authoritative for autofill precedence and NBA
 * acceptance metrics. `fieldSources` jsonb remains a write-through cache on CRM entities
 * (not dropped — unsafe live migration). Dual-write continues on CRM autofill/manual edit,
 * enrichment autofill, call-note autofill, HubSpot inbound, Email-Intel ingest, and NBA
 * suggest/accept.
 *
 * Read adapters: packages/shared field-provenance + GET /:entity/:id/field-sources prefer
 * ledger when present. Autofill uses effectiveSourcesForAutofill (ledger overlays cache).
 */
export const evidenceLedger = pgTable(
  "evidence_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

    // Identity — what fact is this, and where did it come from?
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    attribute: text("attribute").notNull(),
    value: jsonb("value").notNull(),
    source: text("source").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
    method: text("method"),
    region: text("region"),

    // Quality — required confidence per §6.1's anti-hallucination contract; everything else optional.
    authority: text("authority"),
    corroborationCount: integer("corroboration_count").notNull().default(1),
    validation: text("validation"),
    confidence: real("confidence").notNull(),
    freshnessExpiresAt: timestamp("freshness_expires_at", { withTimezone: true }),

    // Resolution — populated when this row represents a resolved (not raw-observed) value.
    chosenValue: jsonb("chosen_value"),
    resolutionRuleOrModelVersion: text("resolution_rule_or_model_version"),
    alternatives: jsonb("alternatives"),
    resolutionReason: text("resolution_reason"),
    reviewerId: uuid("reviewer_id").references(() => users.id, { onDelete: "set null" }),

    // Usage — governs who/what may read this fact and for how long.
    permittedPurpose: text("permitted_purpose"),
    consentBasis: text("consent_basis"),
    channelConstraints: jsonb("channel_constraints"),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("evidence_ledger_workspace_entity_idx").on(table.workspaceId, table.entityType, table.entityId),
    index("evidence_ledger_workspace_entity_attr_idx").on(
      table.workspaceId,
      table.entityType,
      table.entityId,
      table.attribute
    ),
  ]
);

/**
 * §5.2 — probabilistic identity-merge proposals. Scoring never merges anything by itself;
 * a proposal is only created when scoreCandidateMatch (packages/shared) clears
 * MERGE_PROPOSAL_MIN_SCORE, and it sits here as "pending" until a human approves or rejects it
 * via identity-merge.service.ts.
 */
export const identityMergeProposals = pgTable(
  "identity_merge_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    leftEntityId: text("left_entity_id").notNull(),
    rightEntityId: text("right_entity_id").notNull(),
    score: real("score").notNull(),
    signals: jsonb("signals").notNull(),
    /** "pending" | "approved" | "rejected" */
    status: text("status").notNull().default("pending"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("identity_merge_proposals_workspace_status_idx").on(table.workspaceId, table.status)]
);

/** Audit trail for merges/splits — every merge is reversible via its stored beforeSnapshot. */
export const identityMergeEvents = pgTable(
  "identity_merge_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    proposalId: uuid("proposal_id").references(() => identityMergeProposals.id, { onDelete: "set null" }),
    entityType: text("entity_type").notNull(),
    /** "merge" | "split" */
    action: text("action").notNull(),
    primaryEntityId: text("primary_entity_id").notNull(),
    mergedEntityId: text("merged_entity_id").notNull(),
    beforeSnapshot: jsonb("before_snapshot").notNull(),
    afterSnapshot: jsonb("after_snapshot"),
    performedBy: uuid("performed_by").references(() => users.id, { onDelete: "set null" }),
    performedAt: timestamp("performed_at", { withTimezone: true }).notNull().defaultNow(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
  },
  (table) => [index("identity_merge_events_workspace_idx").on(table.workspaceId)]
);
