import { index, integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * §5.3 (Enterprise Completion Plan) — the canonical Evidence Ledger. One shared table for
 * "why do we believe this fact," meant to eventually replace (not yet fully replacing) the
 * three parallel mechanisms already in the codebase: apps/crm's `fieldSources` jsonb column,
 * Email-Intelligence-Tool's own evidenceLedger, and `next_best_action_suggestions`' acceptance
 * tracking.
 *
 * Status: the table plus read/write API (packages/db/src/evidence-writer.ts, re-exported from
 * apps/api/src/services/evidence.service.ts) exist, and the following paths dual-write into it
 * alongside their original write:
 *   - apps/crm CompaniesService.autoFill / ContactsService.autoFill (per-field auto-fill rows)
 *   - apps/api enrichment-autofill.service.ts's applyEnrichmentAutoFill (per-field, enrichment-sourced)
 *   - apps/api next-best-action.service.ts's recordSuggestion / markSuggestionAccepted
 *
 * Still NOT covered (tracked follow-up, not implied as done by this table existing):
 *   - apps/crm's manual-edit path (ContactsService.update / CompaniesService.update) — by
 *     design these don't carry a confidence/observedAt the way auto-fill does, so this needs a
 *     deliberate "manual, confidence 1.0" convention decided before wiring, not a mechanical copy
 *     of the auto-fill dual-write.
 *   - Email-Intelligence-Tool's own separate evidenceLedger implementation, which predates this
 *     table and has not yet been reconciled with it (see that repo's own tracked follow-up).
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
