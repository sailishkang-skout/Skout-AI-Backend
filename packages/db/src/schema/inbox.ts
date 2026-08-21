import { boolean, integer, jsonb, pgTable, real, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { sequenceEnrollments } from "./sequences.js";

export const sendingDomains = pgTable(
  "sending_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    status: text("status").notNull().default("pending_verification"),
    dnsRecords: jsonb("dns_records").notNull().default([]),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    blacklistStatus: text("blacklist_status").notNull().default("clean"),
    blacklistedOn: jsonb("blacklisted_on").notNull().default([]),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    checkError: text("check_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.workspaceId, table.domain)]
);

export const inboxes = pgTable(
  "inboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sendingDomainId: uuid("sending_domain_id").references(() => sendingDomains.id, {
      onDelete: "set null",
    }),
    emailAddress: text("email_address").notNull(),
    displayName: text("display_name"),
    provider: text("provider").notNull().default("smtp"),
    warmupStatus: text("warmup_status").notNull().default("cold"),
    warmupDay: integer("warmup_day").notNull().default(0),
    warmupStartedAt: timestamp("warmup_started_at", { withTimezone: true }),
    dailySendLimit: integer("daily_send_limit").notNull().default(50),
    status: text("status").notNull().default("active"),
    smtpHost: text("smtp_host"),
    smtpPort: integer("smtp_port"),
    smtpUsername: text("smtp_username"),
    smtpPasswordEncrypted: text("smtp_password_encrypted"),
    smtpSecure: boolean("smtp_secure").notNull().default(true),
    // IMAP inbound polling config (reuses SMTP username/password)
    imapHost: text("imap_host"),
    imapPort: integer("imap_port"),
    imapLastPolledAt: timestamp("imap_last_polled_at", { withTimezone: true }),
    // OAuth tokens (Google / Microsoft) — AES-256-GCM encrypted at rest
    oauthAccessTokenEncrypted: text("oauth_access_token_encrypted"),
    oauthRefreshTokenEncrypted: text("oauth_refresh_token_encrypted"),
    oauthTokenExpiresAt: timestamp("oauth_token_expires_at", { withTimezone: true }),
    oauthScope: text("oauth_scope"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    sentCount: integer("sent_count").notNull().default(0),
    bounceCount: integer("bounce_count").notNull().default(0),
    spamCount: integer("spam_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.workspaceId, table.emailAddress)]
);

export const inboxThreads = pgTable("inbox_threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  inboxId: uuid("inbox_id")
    .notNull()
    .references(() => inboxes.id, { onDelete: "cascade" }),
  // Link back to the sequence enrollment that originated this thread (nullable for cold inbound)
  enrollmentId: uuid("enrollment_id").references(() => sequenceEnrollments.id, {
    onDelete: "set null",
  }),
  prospectId: text("prospect_id"),
  subject: text("subject").notNull(),
  // 'new' | 'replied' | 'bounced' | 'meeting_booked' | 'closed'
  status: text("status").notNull().default("new"),
  // Timestamp of the most recent status change (set whenever status transitions)
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
  // Count of unread inbound messages (human replies) in this thread; 0 = all read
  unreadCount: integer("unread_count").notNull().default(0),
  // AI-tagged intent/sentiment of the latest human reply; null until tagged
  // 'positive' | 'negative' | 'neutral' | 'question' | 'meeting_request' | 'unsubscribe' | 'other'
  replyTag: text("reply_tag"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * Manual review resolution UI (condition-engine spec §14/§41 three-tier confidence policy) —
   * a low-confidence AI classification is routed here instead of auto-applying the branch. Set
   * when the tier is "manual_review", cleared once a human approves or dismisses it.
   */
  needsReview: boolean("needs_review").notNull().default(false),
  suggestedTag: text("suggested_tag"),
  suggestedNegativeSubtype: text("suggested_negative_subtype"),
  suggestedConfidence: real("suggested_confidence"),
  suggestedReason: text("suggested_reason"),
});

export const inboxMessages = pgTable("inbox_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id")
    .notNull()
    .references(() => inboxThreads.id, { onDelete: "cascade" }),
  // 'outbound' | 'inbound'
  direction: text("direction").notNull(),
  fromAddress: text("from_address").notNull(),
  toAddress: text("to_address").notNull(),
  subject: text("subject"),
  bodyText: text("body_text"),
  bodyHtml: text("body_html"),
  // Provider's internal message ID (Gmail API id, Graph API id, nodemailer messageId)
  externalId: text("external_id"),
  // RFC 5322 Message-ID header (with angle brackets, e.g. <abc@smtp.example.com>)
  messageId: text("message_id"),
  // RFC 5322 In-Reply-To header — parent message ID
  inReplyTo: text("in_reply_to"),
  // RFC 5322 References header — space-separated chain of ancestor message IDs
  referencesHeader: text("references_header"),
  // 'human' | 'bounce' | 'auto_reply' — null for outbound
  classification: text("classification"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});
