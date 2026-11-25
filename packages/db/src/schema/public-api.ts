import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
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
