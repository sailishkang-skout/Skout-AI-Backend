import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { users } from "./users.js";
import { companies, contacts, deals } from "./crm.js";

/**
 * §8.12 CRM Intelligence (Enterprise Completion Plan) — BuyingCommittee and RetentionRule,
 * the two entities the vision doc calls out as missing from an otherwise-solid CRM core.
 * Wholly additive: no column on companies/contacts/deals is touched.
 *
 * BuyingCommittee models "who's involved in a deal, in what capacity" — a deal or a company
 * can have a standing committee; membership rows carry the stakeholder role and influence.
 */
export const buyingCommittees = pgTable(
  "buying_committees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** A committee is scoped to exactly one of these — enforced in the service layer, not the DB,
     * since Drizzle doesn't have a portable CHECK-one-of-two-nullable-FKs helper. */
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("buying_committees_workspace_id_idx").on(table.workspaceId),
    index("buying_committees_deal_id_idx").on(table.dealId),
    index("buying_committees_company_id_idx").on(table.companyId),
    unique("buying_committees_deal_unique").on(table.dealId),
  ]
);

/**
 * economic_buyer | champion | influencer | blocker | user | unknown — plain text, not a pg enum,
 * matching this schema's existing convention (see crm.ts tasks.type) so new roles don't need a
 * migration.
 */
export const buyingCommitteeMembers = pgTable(
  "buying_committee_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    committeeId: uuid("committee_id")
      .notNull()
      .references(() => buyingCommittees.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("unknown"),
    /** 1 (minimal) to 5 (final decision-maker) — set by rep judgment, not inferred. */
    influence: integer("influence").notNull().default(3),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("buying_committee_members_committee_id_idx").on(table.committeeId),
    unique("buying_committee_members_committee_contact_unique").on(table.committeeId, table.contactId),
  ]
);

/**
 * §8.12's "retention workflows distinguish marketing engagement from contractual truth" —
 * a workspace-configurable rule set classifying an activity/entity as one or the other, so
 * disengagement detection doesn't confuse "stopped opening emails" with "contract at risk."
 * Wave 1 ships the schema + a rule-evaluation service; wiring it into every activity ingestion
 * path (sequence replies, call dispositions, meeting outcomes) is tracked as Wave 2 — see the ADR.
 */
export const retentionRules = pgTable(
  "retention_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** "marketing" | "contractual" — which bucket a match against `criteria` classifies into. */
    classification: text("classification").notNull(),
    /** entityType this rule applies to, e.g. "activity" | "deal" | "contact". */
    entityType: text("entity_type").notNull(),
    /** Match criteria, e.g. { activityType: ["email_open", "email_click"] } or
     * { activityType: ["contract_signed", "renewal_confirmed"] }. Structure is intentionally
     * loose at the schema level — validated by the service layer's zod schema, not the DB. */
    criteria: jsonb("criteria").notNull().default({}),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("retention_rules_workspace_id_idx").on(table.workspaceId),
    index("retention_rules_workspace_active_idx").on(table.workspaceId, table.isActive),
  ]
);
