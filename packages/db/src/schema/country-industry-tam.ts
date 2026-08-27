import { boolean, decimal, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { countries } from "./regional-brief.js";

/**
 * Global TAM data for each country × NAICS industry pair.
 *
 * Backs the getTam() service. The formula (computed at query time, never stored):
 *   target_accounts_tam = round(canonical_include × establishments × effective_icp_fit_pct)
 *   annual_revenue_tam_usd = target_accounts_tam × effective_acv_usd
 *
 * where effective_icp_fit_pct = coalesce(icp_fit_override, icp_fit_pct)
 *       effective_acv_usd     = coalesce(acv_override_usd, acv_usd)
 *
 * Per the Excel Read Me policy: null establishments ≠ zero market. The table ships
 * with NAICS codes and default ICP/ACV placeholders; firm counts require a human to
 * load from licensed/official sources (World Bank Enterprise Surveys, national stat offices).
 */
export const countryIndustryTam = pgTable(
  "country_industry_tam",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    countryId: uuid("country_id")
      .notNull()
      .references(() => countries.id, { onDelete: "cascade" }),
    /** 2022 NAICS 2-digit sector code, e.g. "11", "51", "62". */
    industryCode: text("industry_code").notNull(),
    /** Human-readable sector label, e.g. "Information", "Health Care and Social Assistance". */
    industryName: text("industry_name").notNull(),
    /**
     * Number of establishments in this country × industry.
     * Intentionally null until loaded from an official / licensed source.
     * null ≠ zero market (see Excel Read Me).
     */
    establishments: integer("establishments"),
    /**
     * ICP fit percentage as a decimal fraction, e.g. 0.10 = 10%.
     * Default seeded from the Industry Assumptions sheet.
     */
    icpFitPct: decimal("icp_fit_pct", { precision: 7, scale: 5 }).notNull().default("0.10"),
    /** Override set by a platform admin; takes precedence over icpFitPct when non-null. */
    icpFitOverride: decimal("icp_fit_override", { precision: 7, scale: 5 }),
    /** Default ACV in USD, seeded from the Industry Assumptions sheet. */
    acvUsd: decimal("acv_usd", { precision: 14, scale: 2 }).notNull().default("25000.00"),
    /** Override ACV; takes precedence when non-null. */
    acvOverrideUsd: decimal("acv_override_usd", { precision: 14, scale: 2 }),
    /** Source citation for the establishment count (e.g. "World Bank Enterprise Survey 2024"). */
    dataSource: text("data_source"),
    /** Year the establishment count was published. */
    dataYear: integer("data_year"),
    /**
     * Mirrors the Excel's Canonical Include flag. false = alias row that should not
     * be double-counted in rollups (e.g. a territory counted within a larger country).
     */
    canonicalInclude: boolean("canonical_include").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    countryIndustryUnique: unique().on(table.countryId, table.industryCode),
  })
);
