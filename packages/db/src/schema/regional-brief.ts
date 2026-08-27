import { boolean, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * Top-level regions AND sub-regions live in the same table.
 * Top-level: parentId = null (e.g. NAM, EMEA, APAC, LATAM)
 * Sub-regions: parentId = top-level id (e.g. UKI, NORDICS, DACH, BENELUX under EMEA)
 * Mirrors the Excel's GEOGRAPHY-NEW REGION / REGION-NEW SUB-REGION two-level hierarchy.
 */
export const regions = pgTable("regions", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  /** null = top-level region; non-null = sub-region whose parent is this id. */
  parentId: uuid("parent_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const countries = pgTable("countries", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Points to the SUB-REGION (leaf node). Call parent to get top-level region. */
  regionId: uuid("region_id")
    .notNull()
    .references(() => regions.id, { onDelete: "restrict" }),
  /** ISO 3166-1 alpha-2 code, e.g. "US", "GB" */
  isoCode: text("iso_code").notNull().unique(),
  /** ISO 3166-1 alpha-3 code, e.g. "USA", "GBR" */
  isoAlpha3: text("iso_alpha3").notNull().unique(),
  /** Canonical display name — MASTER COUNTRY value from the Excel. */
  name: text("name").notNull(),
  currencyCode: text("currency_code").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Many-to-one alias table so the country-resolver can map any variant name or code
 * (including alpha-3 codes) to a canonical country_id without storing duplicate country rows.
 * canonicalInclude mirrors the Excel's Canonical Include flag — false = alias-only row
 * that should NOT be double-counted in TAM rollups.
 */
export const countryAliases = pgTable("country_aliases", {
  id: uuid("id").primaryKey().defaultRandom(),
  countryId: uuid("country_id")
    .notNull()
    .references(() => countries.id, { onDelete: "cascade" }),
  /** Any variant: alternate name, alpha-3 code, old name, common misspelling. */
  alias: text("alias").notNull().unique(),
  canonicalInclude: boolean("canonical_include").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Note: unlike a typical enum, layer_type/field_category/status are intentionally left as plain
// text() columns here, not backed by a const array in this file — this codebase's convention
// (see SEQUENCE_MODES/CONDITION_TYPES in apps/api/src/services/sequence.service.ts, which have
// no matching const array in packages/db/src/schema/sequences.ts) keeps business-logic enums in
// the API service layer, not the DB schema package. See regional-brief.service.ts for
// REGIONAL_BRIEF_LAYER_TYPES / REGIONAL_BRIEF_FIELD_CATEGORIES / REGIONAL_BRIEF_VERSION_STATUSES.

export const regionalBriefSlots = pgTable("regional_brief_slots", {
  id: uuid("id").primaryKey().defaultRandom(),
  layerType: text("layer_type").notNull(),
  regionId: uuid("region_id").references(() => regions.id, { onDelete: "cascade" }),
  countryId: uuid("country_id").references(() => countries.id, { onDelete: "cascade" }),
  /** Free-text display label; scope key always uses the NAICS code for uniqueness. */
  industry: text("industry"),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  fieldCategory: text("field_category").notNull(),
  /** Deterministic string derived from the columns above (see buildScopeKey in
   * regional-brief.service.ts) — the real uniqueness key, since Postgres multi-column
   * uniqueness doesn't collapse NULLs the way a single-layer slot needs.
   * Country slots use iso_alpha3 (e.g. country:GBR:data_compliance), not UUID. */
  scopeKey: text("scope_key").notNull().unique(),
  /** Points at the current approved regional_brief_versions.id. Intentionally NOT a DB-level
   * FK (see Global Constraints) — the service always inserts the version before updating this. */
  currentVersionId: uuid("current_version_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const regionalBriefVersions = pgTable(
  "regional_brief_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slotId: uuid("slot_id")
      .notNull()
      .references(() => regionalBriefSlots.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: jsonb("content").notNull().$type<{ summary: string; details: string[] }>(),
    source: text("source").notNull(),
    effectiveDate: timestamp("effective_date", { withTimezone: true }).notNull(),
    confidence: integer("confidence").notNull(),
    evidence: text("evidence").notNull(),
    expiryDate: timestamp("expiry_date", { withTimezone: true }),
    status: text("status").notNull().default("draft"),
    supersedesId: uuid("supersedes_id"),
    reviewerId: uuid("reviewer_id").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slotVersionUnique: unique().on(table.slotId, table.version),
  })
);
