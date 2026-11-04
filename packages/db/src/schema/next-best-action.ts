import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * R20.3 — every AI next-best-action suggestion generated, whether or not the SDR acts on it.
 * `acceptedAt`/`acceptedAction` are set the moment a suggestion is turned into a real CRM
 * action ("create_task" | "enroll_sequence") — this is what makes an acceptance rate
 * measurable (accepted / total), not just a log of what the model said.
 */
export const nextBestActionSuggestions = pgTable(
  "next_best_action_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    actionType: text("action_type").notNull(),
    headline: text("headline").notNull(),
    rationale: text("rationale"),
    draftMessage: text("draft_message"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /** "create_task" | "enroll_sequence" */
    acceptedAction: text("accepted_action"),
    /** taskId or sequenceId, depending on acceptedAction — free text to avoid a nullable dual-FK. */
    acceptedRefId: text("accepted_ref_id"),
    /**
     * COPS-13 account recommendations (Bible p.83). `entityType` is "account" for them.
     * pending | approved | dismissed | expired; a person decides, nothing runs before approval.
     */
    status: text("status").notNull().default("pending"),
    /** renewal_risk | trial_not_activated | ticket_heavy | sla_breached | payment_past_due | expansion_signal | stalled_onboarding */
    recommendationType: text("recommendation_type"),
    /** The rule's confidence (0-1), not the model's. */
    confidence: real("confidence"),
    /** [{kind, id, label}] pointing at real records; at least one for a COPS-13 recommendation. */
    evidenceRefs: jsonb("evidence_refs").notNull().default([]),
    /** {kind: create_task | start_playbook | renewal_prep_task, params} */
    suggestedAction: jsonb("suggested_action"),
    /** Who wrote the rationale: llm | rules. */
    source: text("source"),
    /** Evidence-ledger row written by pinAiClaim. */
    evidenceId: uuid("evidence_id"),
    modelVersionId: uuid("model_version_id"),
    promptVersionId: uuid("prompt_version_id"),
    /** Hash of the context given to the model; the prompt text itself is not stored. */
    inputHash: text("input_hash"),
    /** rule + evidence key: one pending recommendation per key. */
    dedupeKey: text("dedupe_key"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    /** What approve did, e.g. {kind: "task", id}. */
    effect: jsonb("effect"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("nba_suggestions_workspace_id_idx").on(table.workspaceId),
    index("nba_suggestions_workspace_entity_idx").on(table.workspaceId, table.entityType, table.entityId),
    index("nba_suggestions_entity_status_idx").on(table.workspaceId, table.entityType, table.entityId, table.status),
    uniqueIndex("nba_suggestions_pending_dedupe_uq")
      .on(table.workspaceId, table.dedupeKey)
      .where(sql`${table.status} = 'pending' and ${table.dedupeKey} is not null`),
  ]
);

/**
 * COPS-13 warehouse feed (Bible p.87): one checkpoint per sink over the outbox, so the analytics
 * store is fed from the operational DB without reading it twice. Platform-wide, not tenant data.
 */
export const copsAnalyticsFeedCheckpoints = pgTable("cops_analytics_feed_checkpoints", {
  sink: text("sink").primaryKey(),
  lastCreatedAt: timestamp("last_created_at", { withTimezone: true }),
  lastEventId: uuid("last_event_id"),
  eventsSent: bigint("events_sent", { mode: "number" }).notNull().default(0),
  lastError: text("last_error"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
