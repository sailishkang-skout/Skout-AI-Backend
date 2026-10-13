import { bigint, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { users } from "./users.js";
import { deals } from "./crm.js";

/**
 * COPS-03 commercial workspace (Bible p.30-35, 77). Opportunity = deals (COPS-02 mapping).
 * Sent versions are immutable: migration 0111 adds triggers that reject UPDATE of a sent proposal
 * or contract version and any write to the line items of a sent proposal version. Money is integer
 * minor units.
 */
export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** draft | sent | accepted | declined | expired */
    status: text("status").notNull().default("draft"),
    currentVersion: integer("current_version").notNull().default(1),
    statusReason: text("status_reason"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    statusChangedBy: uuid("status_changed_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("proposals_workspace_opportunity_idx").on(t.workspaceId, t.opportunityId)]
);

export const proposalVersions = pgTable(
  "proposal_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    currency: text("currency").notNull(),
    billingCadence: text("billing_cadence").notNull(),
    termMonths: integer("term_months").notNull(),
    discountPct: numeric("discount_pct", { precision: 5, scale: 2 }).notNull().default("0"),
    taxPct: numeric("tax_pct", { precision: 5, scale: 2 }).notNull().default("0"),
    notes: text("notes"),
    subtotalMinor: bigint("subtotal_minor", { mode: "number" }).notNull(),
    discountMinor: bigint("discount_minor", { mode: "number" }).notNull(),
    taxMinor: bigint("tax_minor", { mode: "number" }).notNull(),
    totalMinor: bigint("total_minor", { mode: "number" }).notNull(),
    /** SHA-256 of the canonical content, set when the version is sent. */
    contentHash: text("content_hash"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentBy: uuid("sent_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("proposal_versions_proposal_version_unique").on(t.proposalId, t.version)]
);

export const proposalLineItems = pgTable(
  "proposal_line_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => proposalVersions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** product | seats | credits | fee */
    kind: text("kind").notNull(),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull(),
    unitAmountMinor: bigint("unit_amount_minor", { mode: "number" }).notNull(),
    discountPct: numeric("discount_pct", { precision: 5, scale: 2 }).notNull().default("0"),
    grossMinor: bigint("gross_minor", { mode: "number" }).notNull(),
    discountMinor: bigint("discount_minor", { mode: "number" }).notNull(),
    netMinor: bigint("net_minor", { mode: "number" }).notNull(),
  },
  (t) => [unique("proposal_line_items_version_position_unique").on(t.versionId, t.position)]
);

export const contracts = pgTable(
  "contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    proposalId: uuid("proposal_id").references(() => proposals.id, { onDelete: "set null" }),
    /** msa | order_form | dpa */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    /** draft | sent | signed | declined | expired */
    status: text("status").notNull().default("draft"),
    currentVersion: integer("current_version").notNull().default(1),
    statusReason: text("status_reason"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    statusChangedBy: uuid("status_changed_by").references(() => users.id, { onDelete: "set null" }),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("contracts_workspace_opportunity_idx").on(t.workspaceId, t.opportunityId)]
);

export const contractVersions = pgTable(
  "contract_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    documentUrl: text("document_url").notNull(),
    fileName: text("file_name"),
    fileSha256: text("file_sha256").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentBy: uuid("sent_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("contract_versions_contract_version_unique").on(t.contractId, t.version)]
);

/** Provider-hosted payment links. Only provider references and status are stored, never card data. */
export const paymentRequests = pgTable(
  "payment_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    proposalId: uuid("proposal_id").references(() => proposals.id, { onDelete: "set null" }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    description: text("description"),
    /** requested | paid | failed | expired | cancelled | refunded */
    status: text("status").notNull().default("requested"),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref").notNull(),
    checkoutUrl: text("checkout_url").notNull(),
    providerPaymentId: text("provider_payment_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("payment_requests_provider_ref_unique").on(t.provider, t.providerRef),
    index("payment_requests_workspace_opportunity_idx").on(t.workspaceId, t.opportunityId),
  ]
);

/**
 * Every provider webhook received, keyed by the provider event id (dedupe). `refs` holds only ids,
 * event type, status and amount for reconciliation, never card data. workspace_id is null when the
 * event matched no payment request.
 */
export const paymentProviderEvents = pgTable(
  "payment_provider_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    paymentRequestId: uuid("payment_request_id").references(() => paymentRequests.id, { onDelete: "set null" }),
    /** applied | ignored | unmatched */
    outcome: text("outcome").notNull(),
    refs: jsonb("refs").$type<Record<string, unknown>>().notNull().default({}),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** COPS-07: when the provider created the event, and when we reached its outcome (latency metrics). */
    providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [unique("payment_provider_events_provider_event_unique").on(t.provider, t.providerEventId)]
);

/** Gate policy per deal type; deal_type "*" is the workspace default. */
export const commercialGatePolicies = pgTable(
  "commercial_gate_policies",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    dealType: text("deal_type").notNull(),
    policy: text("policy").notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.dealType] })]
);

/** Per-opportunity gate state. fired_at is set once, with the row locked, and never cleared. */
export const commercialGates = pgTable("commercial_gates", {
  opportunityId: uuid("opportunity_id")
    .primaryKey()
    .references(() => deals.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  trialApprovedAt: timestamp("trial_approved_at", { withTimezone: true }),
  trialApprovedBy: uuid("trial_approved_by").references(() => users.id, { onDelete: "set null" }),
  overrideAt: timestamp("override_at", { withTimezone: true }),
  overrideBy: uuid("override_by").references(() => users.id, { onDelete: "set null" }),
  overrideReason: text("override_reason"),
  firedAt: timestamp("fired_at", { withTimezone: true }),
  firedEventId: uuid("fired_event_id"),
  firedPolicy: text("fired_policy"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
