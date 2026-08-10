import { index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";
import { contacts, tasks } from "./crm.js";

/**
 * R20.2 — one row per Twilio click-to-call bridge attempt. Exists so the call-status webhook
 * (public, no request context) has somewhere durable to record duration/disposition/recording
 * against, and so a `contacts` timeline entry can be traced back to the exact call that produced
 * it (`activityId` below) — recording completion arrives on a *separate* async Twilio webhook
 * that only carries the CallSid, so we look the row up by `callSid`, not by request context.
 */
export const calls = pgTable(
  "calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    callSid: text("call_sid").notNull(),
    agentUserId: uuid("agent_user_id").references(() => users.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    toPhone: text("to_phone"),
    prospectLabel: text("prospect_label"),
    status: text("status").notNull().default("initiated"),
    durationSeconds: integer("duration_seconds"),
    recordingUrl: text("recording_url"),
    /** The `activities` row this call logged on the contact's timeline, once created. */
    activityId: uuid("activity_id"),
    /** R13.3 — free-text notes a rep attaches after the call; source for call_note auto-fill. */
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("calls_call_sid_unique").on(table.callSid),
    index("calls_workspace_id_idx").on(table.workspaceId),
    index("calls_workspace_contact_idx").on(table.workspaceId, table.contactId),
  ]
);
