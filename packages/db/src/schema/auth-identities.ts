import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * AUTH-BE-01 — additive identity layer (Clerk, stub dev tokens, later password / Google / SSO).
 * `users.clerk_user_id` remains the rollback path until BE-25.
 */
export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** clerk | stub | password | google | sso:* */
    provider: text("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    emailAtLink: text("email_at_link").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("auth_identities_provider_subject_unique").on(table.provider, table.providerSubject),
    index("auth_identities_user_id_idx").on(table.userId),
  ]
);

/** Maps legacy `users.clerk_user_id` values to an auth_identities provider for backfill / linking. */
export function providerForClerkUserId(clerkUserId: string): "clerk" | "stub" {
  return clerkUserId.startsWith("stub:") ? "stub" : "clerk";
}
