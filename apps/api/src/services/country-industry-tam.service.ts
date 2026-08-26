import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "../utils/http.js";

import { NAICS_CODE_NAMES } from "./regional-brief.service.js";

const { countries, countryAliases, countryIndustryTam } = schema;

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

export function createCountryIndustryTamService(db: Db) {
  /** Resolve a country by alpha-2, alpha-3, or canonical name (via alias table). */
  async function resolveCountry(isoOrName: string) {
    // 1. Try alpha-2 exact match
    const [byAlpha2] = await db
      .select()
      .from(countries)
      .where(eq(countries.isoCode, isoOrName.toUpperCase()));
    if (byAlpha2) return byAlpha2;

    // 2. Try alpha-3 exact match
    const [byAlpha3] = await db
      .select()
      .from(countries)
      .where(eq(countries.isoAlpha3, isoOrName.toUpperCase()));
    if (byAlpha3) return byAlpha3;

    // 3. Try alias table (case-insensitive via lower())
    const [aliasRow] = await db
      .select({ country: countries })
      .from(countryAliases)
      .innerJoin(countries, eq(countryAliases.countryId, countries.id))
      .where(eq(countryAliases.alias, isoOrName));
    if (aliasRow) return aliasRow.country;

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

      if (!row) {
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
        (row.icpFitOverride !== null ? parseFloat(row.icpFitOverride ?? "0") : null) ??
        parseFloat(row.icpFitPct);
      const effectiveAcvUsd =
        params.acvUsdOverride ??
        (row.acvOverrideUsd !== null ? parseFloat(row.acvOverrideUsd ?? "0") : null) ??
        parseFloat(row.acvUsd);

      const isDataLoaded = row.establishments !== null;
      const targetAccountsTam = isDataLoaded
        ? Math.round(
            (row.canonicalInclude ? 1 : 0) * row.establishments! * effectiveIcpFitPct
          )
        : null;
      const annualRevenueTamUsd =
        targetAccountsTam !== null ? Math.round(targetAccountsTam * effectiveAcvUsd) : null;

      return {
        countryIso2: country.isoCode,
        countryIso3: country.isoAlpha3,
        countryName: country.name,
        industryCode: row.industryCode,
        industryName: row.industryName,
        isDataLoaded,
        targetAccountsTam,
        annualRevenueTamUsd,
        assumptions: {
          establishments: row.establishments,
          icpFitPct: effectiveIcpFitPct,
          acvUsd: effectiveAcvUsd,
          icpFitSource:
            params.icpPctOverride !== undefined || row.icpFitOverride !== null ? "override" : "default",
          acvSource:
            params.acvUsdOverride !== undefined || row.acvOverrideUsd !== null ? "override" : "default",
          canonicalInclude: row.canonicalInclude,
          dataSource: row.dataSource,
          dataYear: row.dataYear,
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
