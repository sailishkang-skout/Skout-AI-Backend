import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { inboxThreads } from "./inbox.js";
import { sequenceEnrollmentSteps } from "./sequences.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const aiDrafts = pgTable("ai_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  prospectId: text("prospect_id").notNull(),
  threadId: uuid("thread_id").references(() => inboxThreads.id, { onDelete: "set null" }),
  enrollmentStepId: uuid("enrollment_step_id").references(() => sequenceEnrollmentSteps.id, {
    onDelete: "set null",
  }),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull().default("pending_review"),
  model: text("model"),
  confidenceScore: numeric("confidence_score", { precision: 5, scale: 4 }),
  /** R13.2 — set when the draft cleared the workspace auto-approve thresholds instead of a human approving it. */
  autoApproved: boolean("auto_approved").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
});

export const crmConnections = pgTable(
  "crm_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("connected"),
    externalAccountId: text("external_account_id"),
    settings: jsonb("settings").notNull().default({}),
    credentialsRef: text("credentials_ref"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.workspaceId, table.provider)]
);

/** Maps Skout prospect_id → CRM record id (e.g. HubSpot contact id) for idempotent export. */
export const crmProspectMappings = pgTable(
  "crm_prospect_mappings",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    prospectId: text("prospect_id").notNull(),
    externalId: text("external_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.workspaceId, table.provider, table.prospectId)]
);

export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  /** Raw HMAC signing secret (maps to secret_hash column for backward compat) */
  secret: text("secret_hash").notNull(),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(true),
  /** jsonb array of subscribed event type strings */
  eventTypes: jsonb("event_types").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const WEBHOOK_EVENT_TYPES = [
  "prospect.enrolled",
  "sequence.step.completed",
  "reply.received",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Workspace-owned enrichment provider API keys (BYOK), encrypted at rest. */
export const workspaceIntegrations = pgTable(
  "workspace_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    encryptedApiKey: text("encrypted_api_key").notNull(),
    keyHint: text("key_hint").notNull(),
    status: text("status").notNull().default("active"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.workspaceId, table.provider)]
);

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  endpointId: uuid("endpoint_id")
    .notNull()
    .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull(),
  eventType: text("event_type").notNull(),
  /** Stable idempotency key shared across retries for the same event+endpoint */
  eventId: text("event_id").notNull(),
  payload: jsonb("payload").notNull(),
  attempt: integer("attempt").notNull().default(1),
  /** pending | success | failed | dead */
  status: text("status").notNull().default("pending"),
  statusCode: integer("status_code"),
  responseBody: text("response_body"),
  durationMs: integer("duration_ms"),
  errorMessage: text("error_message"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
