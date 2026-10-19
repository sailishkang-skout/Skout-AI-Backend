import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { lists, prospectActivations } from "./prospects.js";
import { asyncJobs } from "./jobs.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * ENR-04 — a workspace's link to an external provider account that background enrichment may
 * use. Only the provider's account id and a reference into the server-side secret store are
 * kept here; the secret itself never is. `credential_ref` values:
 *   `workspace_integration:<provider>` — the workspace's own key in `workspace_integrations`
 *   `platform:<provider>`              — the platform key from server configuration
 */
export const enrichmentProviderConnections = pgTable(
  "enrichment_provider_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    credentialRef: text("credential_ref").notNull(),
    /** "active" | "paused" | "revoked" */
    status: text("status").notNull().default("active"),
    capabilities: jsonb("capabilities").notNull().default({}),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    connectedBy: uuid("connected_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("enrichment_provider_connections_account_unique").on(table.workspaceId, table.provider, table.externalAccountId),
    index("enrichment_provider_connections_workspace_status_idx").on(table.workspaceId, table.provider, table.status),
  ]
);

export const enrichmentJobs = pgTable("enrichment_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** The prospect id for a person; the `companies.id` for a company-profile job. */
  prospectId: text("prospect_id").notNull(),
  /** Null for a company-profile job, which has no prospect activation. */
  activationId: uuid("activation_id").references(() => prospectActivations.id, { onDelete: "cascade" }),
  asyncJobId: uuid("async_job_id").references(() => asyncJobs.id, { onDelete: "set null" }),
  batchId: uuid("batch_id"),
  /**
   * "queued" | "running" | "partial" | "action_required" | "failed" | "completed".
   * Every status except queued and running is terminal.
   */
  status: text("status").notNull().default("pending"),
  trigger: text("trigger").notNull().default("manual"),
  fieldsRequested: text("fields_requested").array().notNull().default(["email", "company", "validation"]),
  creditsUsed: integer("credits_used").notNull().default(0),
  errorMessage: text("error_message"),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // ── ENR-04: durable provider jobs ──────────────────────────────────────────
  /** "contact_waterfall" (email/phone/company waterfall) | "linkedin_profile" (provider profile job). */
  kind: text("kind").notNull().default("contact_waterfall"),
  /** "person" | "company" — set for linkedin_profile jobs. */
  targetType: text("target_type"),
  sourceUrl: text("source_url"),
  normalizedUrl: text("normalized_url"),
  provider: text("provider"),
  providerConnectionId: uuid("provider_connection_id").references(() => enrichmentProviderConnections.id, {
    onDelete: "set null",
  }),
  /** Follows one job through logs, attempts, audit entries and the UI. */
  correlationId: uuid("correlation_id").notNull().defaultRandom(),
  /** Client-supplied; a repeated create with the same key returns the same job. */
  idempotencyKey: text("idempotency_key"),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  /** A queued job is not picked up before this time (retry backoff). */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  /** While running, the worker holds the job until this time; past it the job is recoverable. */
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  errorCode: text("error_code"),
  result: jsonb("result"),
  requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
  testMode: boolean("test_mode").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const enrichmentBatches = pgTable("enrichment_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  listId: uuid("list_id"),
  total: integer("total").notNull().default(0),
  done: integer("done").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  status: text("status").notNull().default("queued"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Enriched people/prospects for frontend listing
export const enrichedPeople = pgTable("enriched_people", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  linkedinId: text("linkedin_id").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  email: text("email"),
  title: text("title"),
  company: text("company"),
  profileUrl: text("profile_url"),
  rawData: jsonb("raw_data"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Enriched companies for frontend listing
export const enrichedCompanies = pgTable("enriched_companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  linkedinId: text("linkedin_id").notNull(),
  name: text("name"),
  industry: text("industry"),
  size: text("company_size"),
  website: text("website"),
  headquarters: text("headquarters"),
  profileUrl: text("profile_url"),
  rawData: jsonb("raw_data"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Job change events detected by enrichment
export const jobChangeEvents = pgTable("job_change_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  personId: uuid("person_id")
    .notNull()
    .references(() => enrichedPeople.id, { onDelete: "cascade" }),
  oldTitle: text("old_title"),
  oldCompany: text("old_company"),
  newTitle: text("new_title"),
  newCompany: text("new_company"),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  notified: boolean("notified").notNull().default(false),
});

/**
 * ENR-05 — a saved audience: segmentation filters over captured people, plus the static list
 * its members were last written to, so the audience can feed existing lists and sequences.
 */
export const enrichmentAudiences = pgTable(
  "enrichment_audiences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    filters: jsonb("filters").notNull().default({}),
    listId: uuid("list_id").references(() => lists.id, { onDelete: "set null" }),
    /** Counts at the last save, and outcome totals from campaigns that used the audience. */
    stats: jsonb("stats").notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("enrichment_audiences_workspace_idx").on(table.workspaceId, table.updatedAt)]
);

/**
 * An evidence-to-sequence campaign (ENR-05): an audience, a composed draft, a recorded human
 * approval, and — only after that approval — a sequence the approved recipients are enrolled
 * in. Status: "draft" | "pending_review" | "approved" | "rejected" | "changes_required" |
 * "launched" | "dismissed". Nothing is enrolled or sent before "approved".
 */
export const enrichmentCampaigns = pgTable(
  "enrichment_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    totalProspects: integer("total_prospects").notNull().default(0),
    completedProspects: integer("completed_prospects").notNull().default(0),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    audienceId: uuid("audience_id").references(() => enrichmentAudiences.id, { onDelete: "set null" }),
    /** The sequence created at launch. Null until then. */
    sequenceId: uuid("sequence_id"),
    /** "manual" | "job_change" — a job change only ever creates a draft for review. */
    trigger: text("trigger").notNull().default("manual"),
    sourceChangeEventId: uuid("source_change_event_id"),
    /** Step copy: `{ schemaVersion, composer, steps: [{ order, delayDays, subject, body }] }`. */
    draft: jsonb("draft").notNull().default({}),
    /** Hash of the copy as approved. Each recipient carries the hash of what was approved for them. */
    approvedFingerprint: text("approved_fingerprint"),
    /** Lawful basis the approver recorded for recipients with no consent record yet. */
    consentBasis: text("consent_basis"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    submittedBy: uuid("submitted_by").references(() => users.id, { onDelete: "set null" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    reviewComment: text("review_comment"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("enrichment_campaigns_workspace_status_idx").on(table.workspaceId, table.status, table.updatedAt),
    index("enrichment_campaigns_sequence_idx").on(table.sequenceId),
  ]
);

/**
 * One person in a campaign: whether they may be contacted and why not, the claims proposed for
 * them (each with its evidence reference), the reviewer's decision, and what happened after.
 */
export const enrichmentCampaignRecipients = pgTable(
  "enrichment_campaign_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => enrichmentCampaigns.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id").notNull(),
    fullName: text("full_name"),
    email: text("email"),
    /** "eligible" | "excluded" */
    eligibility: text("eligibility").notNull().default("excluded"),
    exclusionReason: text("exclusion_reason"),
    emailVerification: text("email_verification").notNull().default("unverified"),
    /** "active" | "missing" */
    consentStatus: text("consent_status").notNull().default("missing"),
    /** "included" | "removed" — the reviewer's choice; an excluded person cannot be included. */
    decision: text("decision").notNull().default("included"),
    decisionComment: text("decision_comment"),
    /** `{ reason, talkingPoints, flagged, opening }` — every claim carries its evidence reference. */
    claims: jsonb("claims").notNull().default({}),
    /** Hash of this person's address and the evidence behind their claims, as approved. Null = not covered by an approval. */
    approvedFingerprint: text("approved_fingerprint"),
    enrollmentId: uuid("enrollment_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("enrichment_campaign_recipients_campaign_prospect_unique").on(table.campaignId, table.prospectId),
    index("enrichment_campaign_recipients_enrollment_idx").on(table.enrollmentId),
    index("enrichment_campaign_recipients_workspace_prospect_idx").on(table.workspaceId, table.prospectId),
  ]
);

/** The approval record: who decided what, when, with which comment, over which fingerprint. */
export const enrichmentCampaignReviews = pgTable(
  "enrichment_campaign_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => enrichmentCampaigns.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    reviewerId: uuid("reviewer_id").references(() => users.id, { onDelete: "set null" }),
    /** "approved" | "rejected" | "invalidated" (evidence or recipients changed after approval) */
    decision: text("decision").notNull(),
    comment: text("comment"),
    fingerprint: text("fingerprint"),
    recipientCount: integer("recipient_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("enrichment_campaign_reviews_campaign_idx").on(table.campaignId, table.createdAt)]
);

export const enrichmentAttempts = pgTable(
  "enrichment_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enrichmentJobId: uuid("enrichment_job_id")
      .notNull()
      .references(() => enrichmentJobs.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    attemptOrder: integer("attempt_order").notNull(),
    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    status: text("status").notNull().default("pending"),
    requestInput: jsonb("request_input").notNull().default({}),
    responseOutput: jsonb("response_output"),
    latencyMs: integer("latency_ms"),
    errorMessage: text("error_message"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique().on(table.enrichmentJobId, table.attemptOrder),
    index("enrichment_attempts_workspace_job_idx").on(table.workspaceId, table.enrichmentJobId),
  ]
);

export const enrichmentResults = pgTable("enrichment_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  enrichmentJobId: uuid("enrichment_job_id")
    .notNull()
    .references(() => enrichmentJobs.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  prospectId: text("prospect_id").notNull(),
  fieldName: text("field_name").notNull(),
  fieldValue: text("field_value"),
  fieldValueJson: jsonb("field_value_json"),
  sourceProvider: text("source_provider").notNull(),
  confidence: numeric("confidence", { precision: 5, scale: 4 }),
  validationStatus: text("validation_status"),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A reusable, named enrichment configuration (8.3) — waterfall fields, an optional
 * per-run credit budget, and an email quality threshold. Runs (below) execute a
 * workbook against a target set of prospects; the workbook itself is just config,
 * never touched by execution.
 */
export const enrichmentWorkbooks = pgTable("enrichment_workbooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** EnrichField[] — which waterfall steps a run of this workbook performs. */
  fields: text("fields").array().notNull().default(["company", "email", "validation"]),
  /** 0-1 minimum email-finder confidence to accept before trying the next provider. Null = accept first hit (current engine default). */
  emailQualityThreshold: numeric("email_quality_threshold", { precision: 3, scale: 2 }),
  /** Credits a single run of this workbook may spend. Null = no workbook-specific cap beyond the workspace balance. */
  budgetCreditsPerRun: integer("budget_credits_per_run"),
  /** "draft" | "active" — promoting to production use is an explicit step (activatedAt below), never implicit. */
  status: text("status").notNull().default("draft"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  /** ADI-13 (§8.3) — the static list activation materializes this workbook's successfully-enriched
   * rows into, so "go active" is a visible, traceable hand-off rather than an internal flag flip. */
  resultListId: uuid("result_list_id").references(() => lists.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * §8.3 Task ADI-12 — a user-defined column layered on top of a workbook's fixed 4 fields.
 * Only two `columnType`s exist for this cut: "derived" (a `{{key}}` string-template
 * referencing another column, computed in-process) and "ai_research" (a per-row LLM call).
 * See docs/superpowers/specs/2026-09-05-workbook-flexible-columns-design.md — this
 * deliberately does not touch packages/pal's waterfall engine or the `fields` column above;
 * it's a second, parallel computation pass over the same rows.
 */
export const workbookColumnDefinitions = pgTable(
  "workbook_column_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workbookId: uuid("workbook_id")
      .notNull()
      .references(() => enrichmentWorkbooks.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    /** "derived" | "ai_research" */
    columnType: text("column_type").notNull(),
    /** derived: { template: string }. ai_research: { promptTemplate: string }. */
    config: jsonb("config").notNull(),
    orderIndex: integer("order_index").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.workbookId, table.key)]
);

/**
 * §8.3 Task ADI-12 — one row per (run, column, prospect): the "cell". Run-scoped rather
 * than workbook-scoped, mirroring enrichmentResults being job-scoped — a rerun produces
 * fresh values instead of mutating history, matching this codebase's append-only
 * enrichment-output convention. `evidenceId` is required (non-null) whenever an
 * "ai_research" column succeeds — see pinAiClaim in workbook-column-compute.service.ts.
 */
export const workbookColumnValues = pgTable(
  "workbook_column_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workbookRunId: uuid("workbook_run_id")
      .notNull()
      .references(() => enrichmentWorkbookRuns.id, { onDelete: "cascade" }),
    columnDefinitionId: uuid("column_definition_id")
      .notNull()
      .references(() => workbookColumnDefinitions.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id").notNull(),
    /** "pending" | "succeeded" | "failed" */
    status: text("status").notNull().default("pending"),
    value: text("value"),
    evidenceId: uuid("evidence_id"),
    error: text("error"),
    computedAt: timestamp("computed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("workbook_column_values_run_col_prospect_uidx").on(
      table.workbookRunId,
      table.columnDefinitionId,
      table.prospectId
    ),
  ]
);

/**
 * One execution of a workbook against a resolved set of prospects. Row-level work is
 * tracked by the existing enrichmentJobs/enrichmentBatches tables (batchId below) —
 * this table is the run-level envelope: mode, target set, budget, and pause/resume state.
 */
export const enrichmentWorkbookRuns = pgTable("enrichment_workbook_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workbookId: uuid("workbook_id")
    .notNull()
    .references(() => enrichmentWorkbooks.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  listId: uuid("list_id").notNull(),
  /** "sample" | "selected" | "changed_rows" | "scheduled" (scheduled = the full list). */
  mode: text("mode").notNull(),
  /** Resolved prospect ids this run targets, fixed at start so pause/resume/rerun stay consistent. */
  targetProspectIds: jsonb("target_prospect_ids").notNull().default([]),
  batchId: uuid("batch_id").references(() => enrichmentBatches.id, { onDelete: "set null" }),
  /** "pending" | "running" | "paused" | "completed" | "partial" | "failed" | "cancelled" */
  status: text("status").notNull().default("pending"),
  totalRows: integer("total_rows").notNull().default(0),
  processedRows: integer("processed_rows").notNull().default(0),
  succeededRows: integer("succeeded_rows").notNull().default(0),
  failedRows: integer("failed_rows").notNull().default(0),
  creditsBudget: integer("credits_budget"),
  creditsUsed: integer("credits_used").notNull().default(0),
  /** Set when this run is a "rerun failed cells" of an earlier run — never re-runs the whole workbook. */
  rerunOfRunId: uuid("rerun_of_run_id"),
  errorMessage: text("error_message"),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});