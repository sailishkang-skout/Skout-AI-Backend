import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * Public API keys (PAPI-010, public API PRD §10, KEY-1 to KEY-11).
 *
 * Customer keys for www.skoutai.io/api/public/v1: `sk_live_<prefix>_<secret>` / `sk_test_<prefix>_<secret>`.
 * Kept apart from `cops_api_credentials` because the purpose, scopes and lifecycle differ; the two share
 * the generate/hash helpers in the API instead.
 *
 * Constraints enforced in SQL (migration 0164), not visible in this Drizzle definition:
 * - `type` is 'live' or 'test'; `prefix` is 12 lowercase hex chars.
 * - `expires_at` is required and at most 90 days after `created_at` (KEY-5, D8): no "never expires".
 * - `grace_until` (rotation grace) never passes `expires_at` (KEY-7).
 * - Credit caps, when set, are not negative.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Recorded for audit; the key stops working when this member leaves the workspace (KEY-11). */
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    /** 'live' or 'test'. Test keys never touch the wallet (CRED-10). */
    type: text("type").notNull(),
    /** The public part of the key, used to find the row. */
    prefix: text("prefix").notNull(),
    /** HMAC-SHA256(key, API_KEY_PEPPER). The key itself is never stored (KEY-4). */
    keyHmac: text("key_hmac").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    /** CIDR list; empty means any IP. */
    ipAllowlist: jsonb("ip_allowlist").$type<string[]>().notNull().default([]),
    dailyCreditCap: integer("daily_credit_cap"),
    monthlyCreditCap: integer("monthly_credit_cap"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Which expiry reminders were sent, e.g. { "d14": "<iso>", "d3": "<iso>", "expired": "<iso>" } (KEY-8). */
    expiryRemindersSent: jsonb("expiry_reminders_sent").$type<Record<string, string>>().notNull().default({}),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastUsedIp: text("last_used_ip"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: text("revoke_reason"),
    /** The key that replaced this one on rotation (KEY-7). */
    replacedBy: uuid("replaced_by").references((): AnyPgColumn => apiKeys.id, { onDelete: "set null" }),
    /** After rotation the old key keeps working until this time, then it is revoked. */
    graceUntil: timestamp("grace_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("api_keys_prefix_uq").on(t.prefix),
    index("api_keys_workspace_revoked_idx").on(t.workspaceId, t.revokedAt),
  ]
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

/**
 * One row per public API request, including rejected ones (PAPI-012, PRD §9.7, CRED-12).
 * Metadata only: request and response bodies are never stored.
 *
 * Partitioned by month on `created_at` (migration 0166), so the primary key includes it. Partitions
 * are created ahead and dropped once older than 90 days by `maintainPublicApiTables`.
 * `workspace_id` and `api_key_id` are null when the key could not be resolved.
 */
export const apiRequestLog = pgTable(
  "api_request_log",
  {
    id: uuid("id").notNull().defaultRandom(),
    /** X-Request-Id. */
    requestId: text("request_id").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    method: text("method").notNull(),
    /** Route pattern, e.g. /people/search (never the raw URL with ids or query). */
    endpoint: text("endpoint").notNull(),
    statusCode: integer("status_code").notNull(),
    /** Public error code (CONV-6) when the request failed. */
    errorCode: text("error_code"),
    creditsCharged: integer("credits_charged").notNull().default(0),
    /** The prices used for this request, so a later price change never alters it (CRED-12). */
    priceApplied: jsonb("price_applied").$type<Record<string, number>>(),
    latencyMs: integer("latency_ms"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index("api_request_log_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("api_request_log_key_created_idx").on(t.apiKeyId, t.createdAt),
    index("api_request_log_request_idx").on(t.requestId),
  ]
);

/** Stored responses for `Idempotency-Key` replays (PAPI-012, CONV-2). Purged after 24 hours. */
export const apiIdempotency = pgTable(
  "api_idempotency",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** Hash of method, path and body; a different hash for the same key is a 409. */
    requestHash: text("request_hash").notNull(),
    response: jsonb("response"),
    statusCode: integer("status_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] }), index("api_idempotency_created_idx").on(t.createdAt)]
);

/**
 * Async public API jobs, e.g. batch email verification (PAPI-012, JOB-1, JOB-2).
 * status: queued | running | completed | failed | partially_completed. Results are kept until
 * `results_expire_at` (7 days after finishing).
 */
export const apiJobs = pgTable(
  "api_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    requestId: text("request_id").notNull(),
    /** Operation, e.g. emails.verify. */
    operation: text("operation").notNull(),
    status: text("status").notNull().default("queued"),
    totalItems: integer("total_items").notNull(),
    processedItems: integer("processed_items").notNull().default(0),
    succeededItems: integer("succeeded_items").notNull().default(0),
    failedItems: integer("failed_items").notNull().default(0),
    /** Credit hold covering the whole batch (JOB-1). */
    holdId: uuid("hold_id"),
    /** Where the results are stored (object key), when not inline. */
    resultLocation: text("result_location"),
    /** The batch's items and the price per item snapshotted at reservation (PAPI-058). */
    input: jsonb("input"),
    /** Per-item results, inline (PAPI-058); kept until results_expire_at. */
    results: jsonb("results"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    resultsExpireAt: timestamp("results_expire_at", { withTimezone: true }),
  },
  (t) => [
    index("api_jobs_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("api_jobs_results_expire_idx").on(t.resultsExpireAt),
  ]
);

/** Who accepted which API terms version, when and from where (PAPI-012, ADD-2). Never edited. */
export const apiTermsAcceptances = pgTable(
  "api_terms_acceptances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    termsVersion: text("terms_version").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    ip: text("ip"),
  },
  (t) => [index("api_terms_acceptances_workspace_idx").on(t.workspaceId, t.acceptedAt)]
);

/**
 * Per-workspace public API settings (PAPI-012, ADD-1 to ADD-5, OPS-1). A null limit means "use the
 * global default from env"; CustomerOps sets per-workspace values.
 */
export const workspaceApiSettings = pgTable("workspace_api_settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  addonEnabled: boolean("addon_enabled").notNull().default(false),
  addonEnabledAt: timestamp("addon_enabled_at", { withTimezone: true }),
  addonEnabledBy: uuid("addon_enabled_by").references(() => users.id, { onDelete: "set null" }),
  /** Set when CustomerOps disables the add-on (ADD-5). */
  addonDisabledReason: text("addon_disabled_reason"),
  /** Lets a trial / early-access workspace create live keys (ADD-4). */
  liveAccessForTrial: boolean("live_access_for_trial").notNull().default(false),
  rateTier: text("rate_tier").notNull().default("standard"),
  verifyDailyQuota: integer("verify_daily_quota"),
  searchDailyQuota: integer("search_daily_quota"),
  monthlyCreditCap: integer("monthly_credit_cap"),
  maxActiveKeys: integer("max_active_keys"),
  lowBalanceThreshold: integer("low_balance_threshold"),
  /** When the last low-balance alert went out; at most one per 24 hours (PAPI-036, CRED-8). */
  lowBalanceAlertedAt: timestamp("low_balance_alerted_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
});

/**
 * One row per external data-provider call, including failed and empty ones (PAPI-013, CRED-6), so
 * finance can compute margin per endpoint. Written for enrichment waterfall attempts and for the
 * vendor calls search makes. `cost_micros` (USD millionths) is null when no unit cost is configured;
 * calls made on a workspace's own provider key (`credential_source = 'workspace'`) cost Skout nothing.
 */
export const providerCostEvents = pgTable(
  "provider_cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    /** Public API request id when the call was made for an API request. */
    requestId: text("request_id"),
    /** What triggered the call: enrichment | search. */
    source: text("source").notNull(),
    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    /** ok | miss | error */
    outcome: text("outcome").notNull(),
    /** platform | workspace */
    credentialSource: text("credential_source").notNull().default("platform"),
    /** Billable units the provider counts, e.g. results returned; 1 for a single lookup. */
    units: integer("units").notNull().default(0),
    costMicros: integer("cost_micros"),
    latencyMs: integer("latency_ms"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("provider_cost_events_created_idx").on(t.createdAt),
    index("provider_cost_events_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("provider_cost_events_provider_created_idx").on(t.provider, t.operation, t.createdAt),
  ]
);

/**
 * What each workspace was charged for, per subject and datum type (PAPI-034, CRED-4): the same datum
 * delivered again to the same workspace within 30 days is served from here and costs 0. One row per
 * (workspace, subject, datum type); `delivered_at` is the last *charged* delivery, so free cache hits
 * never extend the window. DSAR deletion removes a subject from every workspace (PRD §9.6).
 */
export const apiDatumCache = pgTable(
  "api_datum_cache",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Stable key of the person or company the datum is about, e.g. "person:<internal id>". */
    subjectKey: text("subject_key").notNull(),
    /** email | phone | person | company | company_jobs | search_page */
    datumType: text("datum_type").notNull(),
    value: jsonb("value").notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.subjectKey, t.datumType] }),
    index("api_datum_cache_subject_idx").on(t.subjectKey),
    index("api_datum_cache_delivered_idx").on(t.deliveredAt),
  ]
);
