import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";
import { tenants } from "./tenancy.js";

/**
 * §8.11 / §9.0 / §9.1 — durable number-provisioning request.
 * Status is the 11-state machine (requested → … → active | failed | expired | cancelled).
 */
export const numberRequests = pgTable(
  "number_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    country: text("country").notNull(),
    region: text("region"),
    city: text("city"),
    areaCode: text("area_code"),
    numberType: text("number_type").notNull().default("local"),
    quantity: integer("quantity").notNull().default(1),
    requestedCapabilities: jsonb("requested_capabilities").notNull().default(["voice"]),
    selectedProvider: text("selected_provider").notNull().default("telnyx"),
    providerSearchId: text("provider_search_id"),
    providerOrderId: text("provider_order_id"),
    providerNumberId: text("provider_number_id"),
    providerRequirementGroupId: text("provider_requirement_group_id"),
    phoneNumber: text("phone_number"),
    status: text("status").notNull().default("requested"),
    complianceStatus: text("compliance_status").notNull().default("not_required"),
    requirementSnapshot: jsonb("requirement_snapshot").notNull().default([]),
    requiredDocuments: jsonb("required_documents").notNull().default([]),
    submittedDocumentVersions: jsonb("submitted_document_versions").notNull().default([]),
    rejectionReason: text("rejection_reason"),
    failureReason: text("failure_reason"),
    assignedWorkspaceId: uuid("assigned_workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    assignedToUserId: uuid("assigned_to_user_id").references(() => users.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key"),
    auditCorrelationId: uuid("audit_correlation_id").notNull().defaultRandom(),
    selectedAt: timestamp("selected_at", { withTimezone: true }),
    complianceSubmittedAt: timestamp("compliance_submitted_at", { withTimezone: true }),
    orderedAt: timestamp("ordered_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("number_requests_workspace_status_idx").on(table.workspaceId, table.status),
    uniqueIndex("number_requests_workspace_idempotency_uidx").on(table.workspaceId, table.idempotencyKey),
  ]
);

export const numberRequestEvents = pgTable(
  "number_request_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => numberRequests.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason"),
    providerPayload: jsonb("provider_payload").notNull().default({}),
    auditCorrelationId: uuid("audit_correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("number_request_events_request_idx").on(table.requestId, table.createdAt)]
);
