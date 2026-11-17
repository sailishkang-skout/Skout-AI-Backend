import { index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { users } from "./users.js";

/**
 * Early access queue (migration 0160): one row per self-signup workspace. COPS approves or rejects it;
 * approval stores the hash of a single-use invite code that the user redeems to unlock the workspace.
 */
export const accessRequests = pgTable(
  "access_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    fullName: text("full_name"),
    company: text("company"),
    roleTitle: text("role_title"),
    useCase: text("use_case"),
    signupMethod: text("signup_method").$type<"password" | "google" | "microsoft">().notNull(),
    status: text("status").$type<"pending" | "approved" | "rejected">().notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    planCode: text("plan_code"),
    creditsGranted: integer("credits_granted"),
    inviteCodeHash: text("invite_code_hash"),
    inviteCodeExpiresAt: timestamp("invite_code_expires_at", { withTimezone: true }),
    inviteCodeRedeemedAt: timestamp("invite_code_redeemed_at", { withTimezone: true }),
    inviteEmailSentAt: timestamp("invite_email_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("access_requests_workspace_unique").on(t.workspaceId),
    index("access_requests_status_created_idx").on(t.status, t.createdAt),
  ]
);
