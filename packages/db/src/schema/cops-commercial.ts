import { bigint, boolean, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { users } from "./users.js";
import { companies, deals } from "./crm.js";

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
    /** COPS-08: terms the approval rules read. The defaults are the standard terms. */
    paymentTermsNetDays: integer("payment_terms_net_days").notNull().default(30),
    freeCredits: integer("free_credits").notNull().default(0),
    customClauses: boolean("custom_clauses").notNull().default(false),
    nonStandardSla: boolean("non_standard_sla").notNull().default(false),
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
    /** COPS-08: per_month | per_term | one_time. Null is the default for the line kind. */
    priceBasis: text("price_basis"),
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
  /** COPS-08: set once by migration 0126 for deals already sent, signed or paid; the approval engine skips them. */
  approvalsGrandfatheredAt: timestamp("approvals_grandfathered_at", { withTimezone: true }),
  approvalsGrandfatheredReason: text("approvals_grandfathered_reason"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** COPS-08 approval engine (Bible p.34): one request per proposal version over a threshold. */
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    proposalVersion: integer("proposal_version").notNull(),
    /** pending | approved | rejected | voided | expired */
    status: text("status").notNull().default("pending"),
    requiredApprovers: jsonb("required_approvers").notNull(),
    matchedRules: jsonb("matched_rules").notNull(),
    /** The material terms the approval was requested for; a change to any of them voids it. */
    terms: jsonb("terms").notNull(),
    /** Version of the approval_policy config used; 0 is the built-in default. */
    policyVersion: integer("policy_version").notNull().default(0),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    statusReason: text("status_reason"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("approvals_workspace_status_idx").on(t.workspaceId, t.status), index("approvals_proposal_idx").on(t.proposalId)]
);

export const approvalDecisions = pgTable(
  "approval_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => approvals.id, { onDelete: "cascade" }),
    approverRole: text("approver_role").notNull(),
    /** pending | approved | rejected */
    decision: text("decision").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("approval_decisions_approval_role_unique").on(t.approvalId, t.approverRole), index("approval_decisions_workspace_idx").on(t.workspaceId)]
);

/** COPS-08 e-signature (Bible p.32): one envelope per send of a contract version. */
export const signatureEnvelopes = pgTable(
  "signature_envelopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    contractVersion: integer("contract_version").notNull(),
    provider: text("provider").notNull(),
    /** The provider's id for the envelope; a reference, never a key of ours. Null until the provider accepts it. */
    providerRef: text("provider_ref"),
    /** pending_send | failed | sent | viewed | expired | declined | signed */
    status: text("status").notNull().default("pending_send"),
    templateKey: text("template_key"),
    signers: jsonb("signers").notNull(),
    mergeFields: jsonb("merge_fields").notNull().default({}),
    sentBy: uuid("sent_by").references(() => users.id, { onDelete: "set null" }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("signature_envelopes_contract_idx").on(t.contractId), index("signature_envelopes_workspace_status_idx").on(t.workspaceId, t.status)]
);

/** Every provider event received, deduplicated by provider event id. Unmatched events have no workspace. */
export const signatureEvents = pgTable(
  "signature_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    envelopeId: uuid("envelope_id").references(() => signatureEnvelopes.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** received | applied | no_change | ignored | unmatched */
    outcome: text("outcome").notNull().default("received"),
    refs: jsonb("refs").notNull().default({}),
  },
  (t) => [unique("signature_events_provider_event_unique").on(t.provider, t.providerEventId), index("signature_events_envelope_idx").on(t.envelopeId)]
);

/** COPS-08 subscriptions (Bible p.36): what an account pays for, one term at a time. */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** The opportunity the subscription came from; its payment links are raised against it. */
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    /** active | past_due | restricted | suspended | closed. Set only from the oldest unpaid bill. */
    status: text("status").notNull().default("active"),
    /** payment_link | invoiced | provider */
    billing: text("billing").notNull(),
    currency: text("currency").notNull(),
    cadence: text("cadence").notNull(),
    termMonths: integer("term_months").notNull(),
    termStart: timestamp("term_start", { withTimezone: true }).notNull(),
    termEnd: timestamp("term_end", { withTimezone: true }).notNull(),
    paymentTermsNetDays: integer("payment_terms_net_days").notNull().default(30),
    /** Provider ids are references, set only for provider billing. */
    providerSubscriptionId: text("provider_subscription_id"),
    providerPlanId: text("provider_plan_id"),
    /** The renewal opportunity opened for this term; set once. */
    renewalOpportunityId: uuid("renewal_opportunity_id").references(() => deals.id, { onDelete: "set null" }),
    renewalOpenedAt: timestamp("renewal_opened_at", { withTimezone: true }),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("subscriptions_workspace_status_idx").on(t.workspaceId, t.status)]
);

export const subscriptionItems = pgTable(
  "subscription_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    quantity: integer("quantity").notNull(),
    /** Per unit per month, in minor units of the subscription currency. */
    unitAmountMinor: bigint("unit_amount_minor", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("subscription_items_subscription_idx").on(t.subscriptionId), index("subscription_items_workspace_idx").on(t.workspaceId)]
);

/** One bill per billing period. Its due date is day 0 of the failed-payment timeline. */
export const subscriptionInvoices = pgTable(
  "subscription_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    /** open | paid | void */
    status: text("status").notNull().default("open"),
    paymentRequestId: uuid("payment_request_id").references(() => paymentRequests.id, { onDelete: "set null" }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("subscription_invoices_period_unique").on(t.subscriptionId, t.periodStart), index("subscription_invoices_workspace_status_idx").on(t.workspaceId, t.status, t.dueAt)]
);

/** COPS-08 amendments (Bible p.37): append-only; a DB trigger rejects UPDATE. */
export const subscriptionAmendments = pgTable(
  "subscription_amendments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** The new seat count, when the amendment changes seats. */
    seats: integer("seats"),
    /** The new term length, when the amendment changes the term. */
    termMonths: integer("term_months"),
    reason: text("reason").notNull(),
    /** A seat change starts with the next billing period; a term change is immediate. */
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    /** What the subscription gave before and after: seats, term and renewal date. */
    before: jsonb("before").notNull(),
    after: jsonb("after").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("subscription_amendments_seq_unique").on(t.subscriptionId, t.seq), index("subscription_amendments_workspace_idx").on(t.workspaceId)]
);
