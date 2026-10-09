import { boolean, index, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { companies, contacts, deals } from "./crm.js";

/**
 * COPS-02 gap tables. Every table carries workspace_id; uniqueness is tenant-scoped.
 * Existing CRM tables (companies, contacts, deals, tasks, activities) are reused; these are the
 * objects the Bible needs that the current schema does not have.
 */

export const accountRelationships = pgTable(
  "account_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentAccountId: uuid("parent_account_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    childAccountId: uuid("child_account_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    relationship: text("relationship").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePair: unique("account_relationships_unique").on(
      t.workspaceId,
      t.parentAccountId,
      t.childAccountId,
      t.relationship
    ),
    workspaceIdx: index("account_relationships_workspace_idx").on(t.workspaceId),
  })
);

/** Verified vs inferred: a lower-confidence write never overwrites a verified value (enforced in the service). */
export const contactChannels = pgTable(
  "contact_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    value: text("value").notNull(),
    verified: boolean("verified").notNull().default(false),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default("0.50"),
    source: text("source").notNull().default("user"),
    suppressed: boolean("suppressed").notNull().default(false),
    bounceStatus: text("bounce_status").notNull().default("none"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueValue: unique("contact_channels_unique").on(t.workspaceId, t.contactId, t.channel, t.value),
    workspaceIdx: index("contact_channels_workspace_idx").on(t.workspaceId, t.contactId),
  })
);

export const opportunityContacts = pgTable(
  "opportunity_contacts",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("stakeholder"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePair: unique("opportunity_contacts_unique").on(t.workspaceId, t.opportunityId, t.contactId),
  })
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueName: unique("tags_workspace_name_unique").on(t.workspaceId, t.name),
  })
);

export const customFieldDefinitions = pgTable(
  "custom_field_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    objectType: text("object_type").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    fieldType: text("field_type").notNull(),
    options: jsonb("options").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueKey: unique("custom_field_definitions_unique").on(t.workspaceId, t.objectType, t.key),
  })
);

export const customFieldValues = pgTable(
  "custom_field_values",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => customFieldDefinitions.id, { onDelete: "cascade" }),
    objectId: uuid("object_id").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePair: unique("custom_field_values_unique").on(t.workspaceId, t.definitionId, t.objectId),
  })
);

/** Tag assignments: one tag on one CRM record (account, contact, opportunity or task). */
export const entityTags = pgTable(
  "entity_tags",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueAssignment: unique("entity_tags_unique").on(t.workspaceId, t.tagId, t.entityType, t.entityId),
    entityIdx: index("entity_tags_entity_idx").on(t.workspaceId, t.entityType, t.entityId),
  })
);
