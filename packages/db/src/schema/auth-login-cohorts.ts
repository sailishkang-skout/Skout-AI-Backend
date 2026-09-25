import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/**
 * AUTH-BE-22 — login-method routing for the cohort migration (ADR-0007 D5 = cohort rollout).
 *
 * Each row routes one email domain, or one exact email address, to a login method. `POST
 * /auth/discover` reads this table to decide which method the identifier-first login screen
 * offers before the user authenticates. An exact-email row overrides a domain row; anything
 * not listed gets the environment default (AUTH_DISCOVERY_DEFAULT_METHOD).
 *
 * This is also where SSO-bound domains live (method = "sso"): workspace_sso_configs has no
 * domain column, so there was no existing domain → SSO binding to reuse.
 *
 * `subject` is stored normalized (trimmed, lowercased; domains without the leading "@").
 */
export const authLoginCohorts = pgTable(
  "auth_login_cohorts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** "domain" | "email" */
    subjectType: text("subject_type").notNull(),
    subject: text("subject").notNull(),
    /** "clerk" | "password" | "google" | "microsoft" | "sso" */
    method: text("method").notNull(),
    /** Free-text operator note (who moved this cohort and why). Never holds secrets. */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("auth_login_cohorts_subject_unique").on(table.subjectType, table.subject)]
);
