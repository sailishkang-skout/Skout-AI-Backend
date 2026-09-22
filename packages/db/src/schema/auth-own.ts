import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * AUTH-BE-10 — own-auth schema (Clerk → custom auth migration, ADR-0007 D2/D4).
 *
 * Every secret-bearing column here stores a hash, never the raw value:
 * - `passwordHash` is an argon2id (or imported bcrypt) hash, never plaintext.
 * - `authRefreshTokens.tokenHash` / `authVerificationTokens.tokenHash` are hashes of
 *   the opaque token actually handed to the client; the raw token is never persisted
 *   (this is the anti-pattern `invite_sessions` has — plaintext tokens — that this
 *   schema deliberately does not repeat).
 */

export const userCredentials = pgTable("user_credentials", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  /** e.g. "argon2id" | "bcrypt" (bcrypt only ever appears here as an imported-from-Clerk value,
   *  verified-then-upgraded to argon2id on next successful login — see AUTH-BE-11/BE-21). */
  hashAlgo: text("hash_algo").notNull(),
  /** Algorithm parameters (memory/time/parallelism cost, or bcrypt cost) — used to decide
   *  whether a stored hash needs a lazy rehash after a parameter change. */
  hashParams: jsonb("hash_params").notNull().default({}),
  passwordUpdatedAt: timestamp("password_updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set true for imported users with no usable hash (AUTH-BE-21) — forces a reset before login. */
  mustReset: boolean("must_reset").notNull().default(false),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    /** Idle timeout (§3 default: 14 days of inactivity). */
    idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
    /** Absolute lifetime regardless of activity (§3 default: 60 days). */
    absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** e.g. "logout" | "logout_all" | "refresh_reuse_detected" | "password_changed" | "blocked". */
    revokedReason: text("revoked_reason"),
    /** Hashed, not raw — session metadata is diagnostic only, never an identifier by itself. */
    userAgentHash: text("user_agent_hash"),
    ipPrefix: text("ip_prefix"),
  },
  (table) => [
    index("auth_sessions_user_id_idx").on(table.userId),
    index("auth_sessions_revoked_at_idx").on(table.revokedAt),
  ]
);

export const authRefreshTokens = pgTable(
  "auth_refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => authSessions.id, { onDelete: "cascade" }),
    /** Hash of the opaque (>=256-bit) refresh token, peppered with AUTH_REFRESH_TOKEN_PEPPER. */
    tokenHash: text("token_hash").notNull().unique(),
    /** Previous token in the rotation chain, for reuse-detection (BE-13). Null for the first
     *  token issued in a session. */
    parentId: uuid("parent_id"),
    usedAt: timestamp("used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("auth_refresh_tokens_session_id_idx").on(table.sessionId),
  ]
);

export const authVerificationTokens = pgTable(
  "auth_verification_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "email_verify" | "password_reset" | "email_otp" (AUTH-BE-15). */
    purpose: text("purpose").notNull(),
    /** Hash of the single-use token/code actually sent to the user. */
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("auth_verification_tokens_user_id_purpose_idx").on(table.userId, table.purpose),
    index("auth_verification_tokens_token_hash_idx").on(table.tokenHash),
  ]
);

export const authEvents = pgTable(
  "auth_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for events with no resolvable user (e.g. login attempt against an unknown email). */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** e.g. "login_success" | "login_failure" | "signup" | "password_reset" |
     *  "refresh_reuse_detected" | "session_revoked" | "account_locked". */
    type: text("type").notNull(),
    ipPrefix: text("ip_prefix"),
    uaHash: text("ua_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Structured detail only — never a token, password, OTP, or other secret (Ground Rule 3). */
    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => [
    index("auth_events_user_id_idx").on(table.userId),
    index("auth_events_type_created_at_idx").on(table.type, table.createdAt),
  ]
);
