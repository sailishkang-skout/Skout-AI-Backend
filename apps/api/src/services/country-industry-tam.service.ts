import { and, eq, ilike } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "../utils/http.js";

import { NAICS_CODE_NAMES } from "./regional-brief.service.js";

const { regions, countries, countryAliases, countryIndustryTam } = schema;

export interface TamResult {
  countryIso2: string;
  countryIso3: string;
  countryName: string;
  industryCode: string;
  industryName: string;
  /** Whether establishment data has been loaded. false = "not loaded" state. */
  isDataLoaded: boolean;
  /** null when establishments is not yet loaded. */
  targetAccountsTam: number | null;
  /** null when establishments is not yet loaded. */
  annualRevenueTamUsd: number | null;
  assumptions: {
    establishments: number | null;
    icpFitPct: number;
    acvUsd: number;
    icpFitSource: "override" | "default";
    acvSource: "override" | "default";
    canonicalInclude: boolean;
    dataSource: string | null;
    dataYear: number | null;
  };
}

export interface UpsertTamInput {
  countryIso: string;
  industryCode: string;
  industryName: string;
  establishments?: number | null;
  icpFitPct?: number;
  icpFitOverride?: number | null;
  acvUsd?: number;
  acvOverrideUsd?: number | null;
  dataSource?: string | null;
  dataYear?: number | null;
  canonicalInclude?: boolean;
}

const STANDARD_REGIONS: Record<string, string> = {
  NAM: "North America",
  EMEA: "Europe, Middle East, Africa",
  APAC: "Asia-Pacific",
  LATAM: "Latin America",
  UKI: "United Kingdom & Ireland",
  DACH: "Germany, Austria, Switzerland",
  NORDICS: "Nordic Countries",
  BENELUX: "Belgium, Netherlands, Luxembourg",
  SEUR: "Southern Europe",
  EEUR: "Eastern Europe",
  ANZ: "Australia & New Zealand",
  SEA: "Southeast Asia",
  EASIA: "East Asia",
  SASIA: "South Asia",
  MEA: "Middle East & Africa",
};

const STANDARD_COUNTRIES: Record<string, { isoCode: string; isoAlpha3: string; name: string; regionCode: string; currencyCode: string; aliases: string[] }> = {
  US: { isoCode: "US", isoAlpha3: "USA", name: "United States", regionCode: "NAM", currencyCode: "USD", aliases: ["US", "USA", "United States", "America", "United States of America"] },
  USA: { isoCode: "US", isoAlpha3: "USA", name: "United States", regionCode: "NAM", currencyCode: "USD", aliases: ["US", "USA", "United States", "America", "United States of America"] },
  "UNITED STATES": { isoCode: "US", isoAlpha3: "USA", name: "United States", regionCode: "NAM", currencyCode: "USD", aliases: ["US", "USA", "United States", "America", "United States of America"] },
  GB: { isoCode: "GB", isoAlpha3: "GBR", name: "United Kingdom", regionCode: "UKI", currencyCode: "GBP", aliases: ["GB", "GBR", "UK", "United Kingdom", "Great Britain", "England"] },
  GBR: { isoCode: "GB", isoAlpha3: "GBR", name: "United Kingdom", regionCode: "UKI", currencyCode: "GBP", aliases: ["GB", "GBR", "UK", "United Kingdom", "Great Britain", "England"] },
  UK: { isoCode: "GB", isoAlpha3: "GBR", name: "United Kingdom", regionCode: "UKI", currencyCode: "GBP", aliases: ["GB", "GBR", "UK", "United Kingdom", "Great Britain", "England"] },
  "UNITED KINGDOM": { isoCode: "GB", isoAlpha3: "GBR", name: "United Kingdom", regionCode: "UKI", currencyCode: "GBP", aliases: ["GB", "GBR", "UK", "United Kingdom", "Great Britain", "England"] },
  "GREAT BRITAIN": { isoCode: "GB", isoAlpha3: "GBR", name: "United Kingdom", regionCode: "UKI", currencyCode: "GBP", aliases: ["GB", "GBR", "UK", "United Kingdom", "Great Britain", "England"] },
  CA: { isoCode: "CA", isoAlpha3: "CAN", name: "Canada", regionCode: "NAM", currencyCode: "CAD", aliases: ["CA", "CAN", "Canada"] },
  CAN: { isoCode: "CA", isoAlpha3: "CAN", name: "Canada", regionCode: "NAM", currencyCode: "CAD", aliases: ["CA", "CAN", "Canada"] },
  CANADA: { isoCode: "CA", isoAlpha3: "CAN", name: "Canada", regionCode: "NAM", currencyCode: "CAD", aliases: ["CA", "CAN", "Canada"] },
  IN: { isoCode: "IN", isoAlpha3: "IND", name: "India", regionCode: "SASIA", currencyCode: "INR", aliases: ["IN", "IND", "India"] },
  IND: { isoCode: "IN", isoAlpha3: "IND", name: "India", regionCode: "SASIA", currencyCode: "INR", aliases: ["IN", "IND", "India"] },
  INDIA: { isoCode: "IN", isoAlpha3: "IND", name: "India", regionCode: "SASIA", currencyCode: "INR", aliases: ["IN", "IND", "India"] },
  DE: { isoCode: "DE", isoAlpha3: "DEU", name: "Germany", regionCode: "DACH", currencyCode: "EUR", aliases: ["DE", "DEU", "Germany", "Deutschland"] },
  DEU: { isoCode: "DE", isoAlpha3: "DEU", name: "Germany", regionCode: "DACH", currencyCode: "EUR", aliases: ["DE", "DEU", "Germany", "Deutschland"] },
  GERMANY: { isoCode: "DE", isoAlpha3: "DEU", name: "Germany", regionCode: "DACH", currencyCode: "EUR", aliases: ["DE", "DEU", "Germany", "Deutschland"] },
  FR: { isoCode: "FR", isoAlpha3: "FRA", name: "France", regionCode: "SEUR", currencyCode: "EUR", aliases: ["FR", "FRA", "France"] },
  FRA: { isoCode: "FR", isoAlpha3: "FRA", name: "France", regionCode: "SEUR", currencyCode: "EUR", aliases: ["FR", "FRA", "France"] },
  FRANCE: { isoCode: "FR", isoAlpha3: "FRA", name: "France", regionCode: "SEUR", currencyCode: "EUR", aliases: ["FR", "FRA", "France"] },
  AU: { isoCode: "AU", isoAlpha3: "AUS", name: "Australia", regionCode: "ANZ", currencyCode: "AUD", aliases: ["AU", "AUS", "Australia"] },
  AUS: { isoCode: "AU", isoAlpha3: "AUS", name: "Australia", regionCode: "ANZ", currencyCode: "AUD", aliases: ["AU", "AUS", "Australia"] },
  AUSTRALIA: { isoCode: "AU", isoAlpha3: "AUS", name: "Australia", regionCode: "ANZ", currencyCode: "AUD", aliases: ["AU", "AUS", "Australia"] },
};

const STANDARD_TAM_ROWS: Record<string, { industryName: string; establishments: number; icpFitPct: number; acvUsd: number; dataSource: string; dataYear: number }> = {
  "US:51": {
    industryName: "Information",
    establishments: 162006,
    icpFitPct: 0.10,
    acvUsd: 25000,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  "US:52": {
    industryName: "Finance and Insurance",
    establishments: 478891,
    icpFitPct: 0.10,
    acvUsd: 25000,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  "US:54": {
    industryName: "Professional, Scientific, and Technical Services",
    establishments: 1045230,
    icpFitPct: 0.10,
    acvUsd: 25000,
    dataSource: "US Census Bureau Statistics of U.S. Businesses (SUSB) 2021",
    dataYear: 2021,
  },
  "GB:51": {
    industryName: "Information and Communication",
    establishments: 375000,
    icpFitPct: 0.10,
    acvUsd: 25000,
    dataSource: "UK Department for Business and Trade Business Population Estimates (BPE) 2023",
    dataYear: 2023,
  },
};

export function createCountryIndustryTamService(db: Db) {
  async function resolveRegionId(regionCode: string) {
    const [region] = await db.select().from(regions).where(eq(regions.code, regionCode.toUpperCase()));
    if (region) return region;

    const standardName = STANDARD_REGIONS[regionCode.toUpperCase()];
    if (standardName) {
      const [created] = await db
        .insert(regions)
        .values({ code: regionCode.toUpperCase(), name: standardName })
        .onConflictDoNothing()
        .returning();
      if (created) return created;
      const [reloaded] = await db.select().from(regions).where(eq(regions.code, regionCode.toUpperCase()));
      if (reloaded) return reloaded;
    }

    throw new HttpError(`Unknown region code: ${regionCode}`, 422);
  }

  /** Resolve a country by alpha-2, alpha-3, or canonical name (via alias table). */
  async function resolveCountry(isoOrName: string) {
    const key = isoOrName.trim();
    // 1. Try alpha-2 exact match
    const [byAlpha2] = await db
      .select()
      .from(countries)
      .where(eq(countries.isoCode, key.toUpperCase()));
    if (byAlpha2) return byAlpha2;

    // 2. Try alpha-3 exact match
    const [byAlpha3] = await db
      .select()
      .from(countries)
      .where(eq(countries.isoAlpha3, key.toUpperCase()));
    if (byAlpha3) return byAlpha3;

    // 3. Try name exact / case-insensitive match
    const [byName] = await db
      .select()
      .from(countries)
      .where(ilike(countries.name, key));
    if (byName) return byName;

    // 4. Try alias table (case-insensitive via ilike())
    const [aliasRow] = await db
      .select({ country: countries })
      .from(countryAliases)
      .innerJoin(countries, eq(countryAliases.countryId, countries.id))
      .where(ilike(countryAliases.alias, key));
    if (aliasRow) return aliasRow.country;

    // Auto-provision standard country if database was not pre-seeded
    const standard = STANDARD_COUNTRIES[key.toUpperCase()];
    if (standard) {
      const region = await resolveRegionId(standard.regionCode);
      const [created] = await db
        .insert(countries)
        .values({
          isoCode: standard.isoCode,
          isoAlpha3: standard.isoAlpha3,
          name: standard.name,
          regionId: region.id,
          currencyCode: standard.currencyCode,
        })
        .onConflictDoNothing()
        .returning();

      const country = created || (await db.select().from(countries).where(eq(countries.isoCode, standard.isoCode)))[0];
      if (country) {
        for (const alias of standard.aliases) {
          await db
            .insert(countryAliases)
            .values({ countryId: country.id, alias, canonicalInclude: true })
            .onConflictDoNothing();
        }
        return country;
      }
    }

    throw new HttpError(`Cannot resolve country: "${isoOrName}"`, 422);
  }

  return {
    async getTam(params: {
      countryIso: string;
      naicsCode: string;
      icpPctOverride?: number;
      acvUsdOverride?: number;
    }): Promise<TamResult> {
      const country = await resolveCountry(params.countryIso);

      const [row] = await db
        .select()
        .from(countryIndustryTam)
        .where(
          and(
            eq(countryIndustryTam.countryId, country.id),
            eq(countryIndustryTam.industryCode, params.naicsCode)
          )
        );

      let currentRow = row;
      if (!currentRow) {
        const standardTam = STANDARD_TAM_ROWS[`${country.isoCode}:${params.naicsCode}`];
        if (standardTam) {
          const [inserted] = await db
            .insert(countryIndustryTam)
            .values({
              countryId: country.id,
              industryCode: params.naicsCode,
              industryName: standardTam.industryName,
              establishments: standardTam.establishments,
              icpFitPct: standardTam.icpFitPct.toString(),
              acvUsd: standardTam.acvUsd.toString(),
              dataSource: standardTam.dataSource,
              dataYear: standardTam.dataYear,
              canonicalInclude: true,
            })
            .onConflictDoNothing()
            .returning();
          currentRow = inserted || (await db.select().from(countryIndustryTam).where(and(eq(countryIndustryTam.countryId, country.id), eq(countryIndustryTam.industryCode, params.naicsCode))))[0];
        }
      }

      if (!currentRow) {
        return {
          countryIso2: country.isoCode,
          countryIso3: country.isoAlpha3,
          countryName: country.name,
          industryCode: params.naicsCode,
          industryName: NAICS_CODE_NAMES[params.naicsCode] ?? `NAICS ${params.naicsCode}`,
          isDataLoaded: false,
          targetAccountsTam: null,
          annualRevenueTamUsd: null,
          assumptions: {
            establishments: null,
            icpFitPct: params.icpPctOverride ?? 0.1,
            acvUsd: params.acvUsdOverride ?? 25000,
            icpFitSource: params.icpPctOverride !== undefined ? "override" : "default",
            acvSource: params.acvUsdOverride !== undefined ? "override" : "default",
            canonicalInclude: true,
            dataSource: null,
            dataYear: null,
          },
        };
      }

      const effectiveIcpFitPct =
        params.icpPctOverride ??
        (currentRow.icpFitOverride !== null ? parseFloat(currentRow.icpFitOverride ?? "0") : null) ??
        parseFloat(currentRow.icpFitPct);
      const effectiveAcvUsd =
        params.acvUsdOverride ??
        (currentRow.acvOverrideUsd !== null ? parseFloat(currentRow.acvOverrideUsd ?? "0") : null) ??
        parseFloat(currentRow.acvUsd);

      const isDataLoaded = currentRow.establishments !== null;
      const targetAccountsTam = isDataLoaded
        ? Math.round(
            (currentRow.canonicalInclude ? 1 : 0) * currentRow.establishments! * effectiveIcpFitPct
          )
        : null;
      const annualRevenueTamUsd =
        targetAccountsTam !== null ? Math.round(targetAccountsTam * effectiveAcvUsd) : null;

      return {
        countryIso2: country.isoCode,
        countryIso3: country.isoAlpha3,
        countryName: country.name,
        industryCode: currentRow.industryCode,
        industryName: currentRow.industryName,
        isDataLoaded,
        targetAccountsTam,
        annualRevenueTamUsd,
        assumptions: {
          establishments: currentRow.establishments,
          icpFitPct: effectiveIcpFitPct,
          acvUsd: effectiveAcvUsd,
          icpFitSource:
            params.icpPctOverride !== undefined || currentRow.icpFitOverride !== null ? "override" : "default",
          acvSource:
            params.acvUsdOverride !== undefined || currentRow.acvOverrideUsd !== null ? "override" : "default",
          canonicalInclude: currentRow.canonicalInclude,
          dataSource: currentRow.dataSource,
          dataYear: currentRow.dataYear,
        },
      };
    },

    async listTamRows(countryIso?: string) {
      if (!countryIso) {
        return db.select().from(countryIndustryTam);
      }
      const country = await resolveCountry(countryIso);
      return db
        .select()
        .from(countryIndustryTam)
        .where(eq(countryIndustryTam.countryId, country.id));
    },

    async upsertTamRow(input: UpsertTamInput) {
      const country = await resolveCountry(input.countryIso);

      const [existing] = await db
        .select()
        .from(countryIndustryTam)
        .where(
          and(
            eq(countryIndustryTam.countryId, country.id),
            eq(countryIndustryTam.industryCode, input.industryCode)
          )
        );

      if (existing) {
        const [updated] = await db
          .update(countryIndustryTam)
          .set({
            industryName: input.industryName,
            establishments: input.establishments ?? existing.establishments,
            icpFitPct: input.icpFitPct?.toFixed(5) ?? existing.icpFitPct,
            icpFitOverride:
              input.icpFitOverride !== undefined
                ? input.icpFitOverride?.toFixed(5) ?? null
                : existing.icpFitOverride,
            acvUsd: input.acvUsd?.toFixed(2) ?? existing.acvUsd,
            acvOverrideUsd:
              input.acvOverrideUsd !== undefined
                ? input.acvOverrideUsd?.toFixed(2) ?? null
                : existing.acvOverrideUsd,
            dataSource: input.dataSource ?? existing.dataSource,
            dataYear: input.dataYear ?? existing.dataYear,
            canonicalInclude: input.canonicalInclude ?? existing.canonicalInclude,
            updatedAt: new Date(),
          })
          .where(eq(countryIndustryTam.id, existing.id))
          .returning();
        return updated!;
      }

      const [created] = await db
        .insert(countryIndustryTam)
        .values({
          countryId: country.id,
          industryCode: input.industryCode,
          industryName: input.industryName,
          establishments: input.establishments ?? null,
          icpFitPct: (input.icpFitPct ?? 0.1).toFixed(5),
          icpFitOverride: input.icpFitOverride?.toFixed(5) ?? null,
          acvUsd: (input.acvUsd ?? 25000).toFixed(2),
          acvOverrideUsd: input.acvOverrideUsd?.toFixed(2) ?? null,
          dataSource: input.dataSource ?? null,
          dataYear: input.dataYear ?? null,
          canonicalInclude: input.canonicalInclude ?? true,
        })
        .returning();
      return created!;
    },
  };
}
