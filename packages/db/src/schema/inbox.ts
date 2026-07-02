import { boolean, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

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
    dailySendLimit: integer("daily_send_limit").notNull().default(50),
    status: text("status").notNull().default("active"),
    smtpHost: text("smtp_host"),
    smtpPort: integer("smtp_port"),
    smtpUsername: text("smtp_username"),
    smtpPasswordEncrypted: text("smtp_password_encrypted"),
    smtpSecure: boolean("smtp_secure").notNull().default(true),
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
  prospectId: text("prospect_id"),
  subject: text("subject").notNull(),
  status: text("status").notNull().default("open"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inboxMessages = pgTable("inbox_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id")
    .notNull()
    .references(() => inboxThreads.id, { onDelete: "cascade" }),
  direction: text("direction").notNull(),
  fromAddress: text("from_address").notNull(),
  toAddress: text("to_address").notNull(),
  subject: text("subject"),
  bodyText: text("body_text"),
  bodyHtml: text("body_html"),
  externalId: text("external_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});
