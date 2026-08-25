import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * §16 — Data Subject Access Request (DSAR) queue.
 * fulfillmentMode: "manual" (legal/ops SLA queue) | "auto" (access/portability JSON export).
 * Default SLA: 30 calendar days from createdAt (GDPR-style).
 */
export const dataSubjectRequests = pgTable(
  "data_subject_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** access | erasure | rectification | portability */
    requestType: text("request_type").notNull(),
    subjectEmail: text("subject_email").notNull(),
    subjectType: text("subject_type").notNull().default("prospect"),
    subjectId: text("subject_id"),
    status: text("status").notNull().default("received"),
    /** manual | auto */
    fulfillmentMode: text("fulfillment_mode").notNull().default("manual"),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
    /** JSON string of auto-export package (access/portability). */
    exportPayload: text("export_payload"),
    exportCompletedAt: timestamp("export_completed_at", { withTimezone: true }),
    notes: text("notes"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("dsar_workspace_status_idx").on(table.workspaceId, table.status),
    index("dsar_subject_email_idx").on(table.subjectEmail),
  ]
);
