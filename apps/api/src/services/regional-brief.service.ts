import { and, desc, eq, ilike } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import { HttpError } from "../utils/http.js";
import type { Env } from "../config/env.js";

const { regions, countries, countryAliases, regionalBriefSlots, regionalBriefVersions } = schema;

const log = createLogger("regional-brief.service");

/** global → sub-region → country → industry → tenant → outcome_learning, each overriding the one before it. */
export const REGIONAL_BRIEF_LAYER_TYPES = [
  "global",
  "region",
  "country",
  "industry",
  "tenant",
  "outcome_learning",
] as const;
export type RegionalBriefLayerType = (typeof REGIONAL_BRIEF_LAYER_TYPES)[number];

export const REGIONAL_BRIEF_FIELD_CATEGORIES = [
  "market_economics",
  "business_practice",
  "channel_policy",
  "telecom_requirements",
  "data_compliance",
  "explainability",
] as const;
export type RegionalBriefFieldCategory = (typeof REGIONAL_BRIEF_FIELD_CATEGORIES)[number];

export const REGIONAL_BRIEF_VERSION_STATUSES = ["draft", "pending_review", "approved", "rejected", "superseded"] as const;
export type RegionalBriefVersionStatus = (typeof REGIONAL_BRIEF_VERSION_STATUSES)[number];

/**
 * NAICS 2022 — 20 broad sector synonym map.
 * Maps common user phrases → NAICS 2-digit code.
 * Intended as a deterministic starter dictionary; grows when the ICP/CRM layer
 * introduces its own industry taxonomy.
 */
export const NAICS_SYNONYMS: Record<string, string> = {
  // 11 — Agriculture, Forestry, Fishing and Hunting
  agriculture: "11", farming: "11", forestry: "11", fishing: "11",
  // 21 — Mining, Quarrying, and Oil and Gas Extraction
  mining: "21", "oil and gas": "21", "oil & gas": "21", quarrying: "21",
  // 22 — Utilities
  utilities: "22", energy: "22", electricity: "22", "electric utility": "22",
  // 23 — Construction
  construction: "23",
  // 31 — Manufacturing (31-33 grouped)
  manufacturing: "31", industrial: "31",
  // 42 — Wholesale Trade
  wholesale: "42", "wholesale trade": "42",
  // 44 — Retail Trade (44-45 grouped)
  retail: "44", "retail trade": "44", ecommerce: "44", "e-commerce": "44",
  // 48 — Transportation and Warehousing (48-49 grouped)
  transportation: "48", logistics: "48", warehousing: "48", shipping: "48", "supply chain": "48",
  // 51 — Information
  information: "51", software: "51", saas: "51", "software as a service": "51",
  technology: "51", tech: "51", "information technology": "51", it: "51",
  media: "51", publishing: "51", telecommunications: "51", telecom: "51",
  // 52 — Finance and Insurance
  finance: "52", financial: "52", banking: "52", insurance: "52",
  fintech: "52", "financial services": "52",
  // 53 — Real Estate and Rental and Leasing
  "real estate": "53", realestate: "53", proptech: "53", "property management": "53",
  // 54 — Professional, Scientific, and Technical Services
  professional: "54", consulting: "54", legal: "54", accounting: "54",
  "professional services": "54", engineering: "54",
  // 55 — Management of Companies and Enterprises
  management: "55", "holding company": "55",
  // 56 — Administrative and Support and Waste Management and Remediation Services
  administrative: "56", "staffing agency": "56", recruiting: "56", hr: "56",
  "human resources": "56",
  // 61 — Educational Services
  education: "61", edtech: "61", "higher education": "61", training: "61",
  // 62 — Health Care and Social Assistance
  healthcare: "62", "health care": "62", medical: "62", pharma: "62",
  pharmaceutical: "62", biotech: "62", healthtech: "62",
  // 71 — Arts, Entertainment, and Recreation
  entertainment: "71", gaming: "71", sports: "71", arts: "71",
  // 72 — Accommodation and Food Services
  hospitality: "72", hotel: "72", restaurant: "72", "food service": "72",
  // 81 — Other Services (except Public Administration)
  "other services": "81", nonprofit: "81",
  // 92 — Public Administration
  government: "92", "public administration": "92", "public sector": "92",
};

/**
 * Normalize an industry phrase (NAICS code passthrough or synonym lookup).
 * Returns { code, displayName } or null when the phrase is not recognized.
 */
export function normalizeIndustry(phrase: string): { code: string; displayName: string } | null {
  if (!phrase) return null;
  const trimmed = phrase.trim();

  // If it looks like a bare NAICS code (1-3 digits) return it directly
  if (/^\d{1,3}$/.test(trimmed)) {
    const name = NAICS_CODE_NAMES[trimmed] ?? `NAICS ${trimmed}`;
    return { code: trimmed, displayName: name };
  }

  const key = trimmed.toLowerCase();
  const code = NAICS_SYNONYMS[key];
  if (code) return { code, displayName: NAICS_CODE_NAMES[code] ?? `NAICS ${code}` };
  return null;
}

/** Reverse lookup: NAICS code → canonical sector name. */
export const NAICS_CODE_NAMES: Record<string, string> = {
  "11": "Agriculture, Forestry, Fishing and Hunting",
  "21": "Mining, Quarrying, and Oil and Gas Extraction",
  "22": "Utilities",
  "23": "Construction",
  "31": "Manufacturing",
  "42": "Wholesale Trade",
  "44": "Retail Trade",
  "48": "Transportation and Warehousing",
  "51": "Information",
  "52": "Finance and Insurance",
  "53": "Real Estate and Rental and Leasing",
  "54": "Professional, Scientific, and Technical Services",
  "55": "Management of Companies and Enterprises",
  "56": "Administrative and Support and Waste Management and Remediation Services",
  "61": "Educational Services",
  "62": "Health Care and Social Assistance",
  "71": "Arts, Entertainment, and Recreation",
  "72": "Accommodation and Food Services",
  "81": "Other Services (except Public Administration)",
  "92": "Public Administration",
};

export function isPlatformAdmin(
  config: Pick<Env, "PLATFORM_ADMIN_EMAILS">,
  email: string | undefined
): boolean {
  if (!email) return false;
  return config.PLATFORM_ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

export interface ScopeKeyInput {
  layerType: RegionalBriefLayerType;
  regionCode?: string | null;
  /** iso_alpha3, e.g. "USA", "GBR" — NOT the UUID. Scope keys use alpha-3 for stability. */
  countryIso3?: string | null;
  /** NAICS sector code, e.g. "51". NOT a free-text phrase. */
  naicsCode?: string | null;
  workspaceId?: string | null;
  fieldCategory: RegionalBriefFieldCategory;
}

/**
 * Deterministic scope key. Uses iso_alpha3 for country (not UUID) and NAICS code for
 * industry (not free text) so keys are stable across row recreations.
 */
export function buildScopeKey(input: ScopeKeyInput): string {
  const { layerType, fieldCategory } = input;
  switch (layerType) {
    case "global":
      return `global:${fieldCategory}`;
    case "region":
      return `region:${input.regionCode}:${fieldCategory}`;
    case "country":
      return `country:${input.countryIso3}:${fieldCategory}`;
    case "industry":
      return `industry:${input.naicsCode}:${fieldCategory}`;
    case "tenant":
      return `tenant:${input.workspaceId}:${input.countryIso3}:${fieldCategory}`;
    case "outcome_learning":
      return `outcome:${input.workspaceId}:${input.countryIso3}:${fieldCategory}`;
    default: {
      const _exhaustive: never = layerType;
      throw new HttpError(`Unknown layer type: ${_exhaustive}`, 400);
    }
  }
}

export interface CreateSlotInput {
  layerType: RegionalBriefLayerType;
  /** Alpha-2, alpha-3, or canonical name — resolved internally. */
  countryIso?: string;
  regionCode?: string;
  /** Free-text display label OR NAICS code — resolved internally. Stored as display label on slot. */
  industry?: string;
  workspaceId?: string;
  fieldCategory: RegionalBriefFieldCategory;
}

export interface CreateVersionInput {
  content: { summary: string; details: string[] };
  source: string;
  effectiveDate: Date;
  confidence: number;
  evidence: string;
  expiryDate?: Date | null;
  createdBy: string;
}

export interface ResolvedBriefEntry {
  fieldCategory: RegionalBriefFieldCategory;
  content: { summary: string; details: string[] };
  resolvedFromLayer: RegionalBriefLayerType;
  source: string;
  confidence: number;
  effectiveDate: string;
  evidence: string;
  isStale: boolean;
}

export interface ResolvedBrief {
  country: string;        // canonical display name, e.g. "United Kingdom"
  countryIso3: string;   // alpha-3 code, e.g. "GBR"
  industry: string | null;      // NAICS sector code if resolved, null otherwise
  industryName: string | null;  // display name, e.g. "Information"
  industryInputWarning?: string; // set when the industry phrase was not recognized
  workspaceId: string | null;
  entries: ResolvedBriefEntry[];
}

export function createRegionalBriefService(db: Db) {
  /**
   * Resolve any country identifier (alpha-2, alpha-3, or canonical name) to a DB row.
   * Lookup order: alpha-2 exact → alpha-3 exact → alias table.
   */
  async function resolveCountry(isoOrName: string) {
    const [byAlpha2] = await db
      .select()
      .from(countries)
      .where(eq(countries.isoCode, isoOrName.toUpperCase()));
    if (byAlpha2) return byAlpha2;

    const [byAlpha3] = await db
      .select()
      .from(countries)
      .where(eq(countries.isoAlpha3, isoOrName.toUpperCase()));
    if (byAlpha3) return byAlpha3;

    const [byName] = await db
      .select()
      .from(countries)
      .where(ilike(countries.name, isoOrName));
    if (byName) return byName;

    // Case-insensitive alias lookup
    const [aliasRow] = await db
      .select({ country: countries })
      .from(countryAliases)
      .innerJoin(countries, eq(countryAliases.countryId, countries.id))
      .where(ilike(countryAliases.alias, isoOrName));
    if (aliasRow) return aliasRow.country;

    throw new HttpError(`Cannot resolve country: "${isoOrName}"`, 422);
  }

  async function resolveRegionId(regionCode: string) {
    const [region] = await db.select().from(regions).where(eq(regions.code, regionCode));
    if (!region) throw new HttpError(`Unknown region code: ${regionCode}`, 422);
    return region;
  }

  async function resolveSlotIds(input: CreateSlotInput) {
    let countryIso3: string | null = null;
    let countryId: string | null = null;
    let regionId: string | null = null;
    let regionCode: string | null = null;

    if (input.countryIso) {
      const country = await resolveCountry(input.countryIso);
      countryId = country.id;
      countryIso3 = country.isoAlpha3;
      // region defaults to the country's sub-region
      regionId = country.regionId;
    }
    if (input.regionCode) {
      const region = await resolveRegionId(input.regionCode);
      regionId = region.id;
      regionCode = region.code;
    }
    return { regionId, regionCode, countryId, countryIso3 };
  }

  return {
    async findOrCreateSlot(input: CreateSlotInput) {
      const { regionId, regionCode, countryId, countryIso3 } = await resolveSlotIds(input);

      // Normalize industry to NAICS code for the scope key
      const industryNormalized = input.industry ? normalizeIndustry(input.industry) : null;
      const naicsCode = industryNormalized?.code ?? null;

      const scopeKey = buildScopeKey({
        layerType: input.layerType,
        regionCode: regionCode ?? null,
        countryIso3: countryIso3 ?? null,
        naicsCode,
        workspaceId: input.workspaceId ?? null,
        fieldCategory: input.fieldCategory,
      });

      const [existing] = await db.select().from(regionalBriefSlots).where(eq(regionalBriefSlots.scopeKey, scopeKey));
      if (existing) return existing;

      const [created] = await db
        .insert(regionalBriefSlots)
        .values({
          layerType: input.layerType,
          regionId,
          countryId,
          // Store the original display label; scope key uses NAICS code
          industry: industryNormalized?.displayName ?? input.industry ?? null,
          workspaceId: input.workspaceId ?? null,
          fieldCategory: input.fieldCategory,
          scopeKey,
        })
        .returning();
      log.info("regional brief slot created", { scopeKey, layerType: input.layerType });
      return created!;
    },

    async createDraftVersion(slotId: string, input: CreateVersionInput) {
      const [slot] = await db.select().from(regionalBriefSlots).where(eq(regionalBriefSlots.id, slotId));
      if (!slot) throw new HttpError("regional_brief_slot_not_found", 404);

      const [latest] = await db
        .select({ version: regionalBriefVersions.version })
        .from(regionalBriefVersions)
        .where(eq(regionalBriefVersions.slotId, slotId))
        .orderBy(desc(regionalBriefVersions.version))
        .limit(1);
      const nextVersion = (latest?.version ?? 0) + 1;

      const [created] = await db
        .insert(regionalBriefVersions)
        .values({
          slotId,
          version: nextVersion,
          content: input.content,
          source: input.source,
          effectiveDate: input.effectiveDate,
          confidence: input.confidence,
          evidence: input.evidence,
          expiryDate: input.expiryDate ?? null,
          status: "draft",
          createdBy: input.createdBy,
        })
        .returning();
      log.info("regional brief draft version created", { slotId, version: nextVersion });
      return created!;
    },

    async approveVersion(versionId: string, reviewerId: string) {
      return db.transaction(async (tx) => {
        const [version] = await tx.select().from(regionalBriefVersions).where(eq(regionalBriefVersions.id, versionId));
        if (!version) throw new HttpError("regional_brief_version_not_found", 404);
        if (version.status !== "draft" && version.status !== "pending_review") {
          throw new HttpError(`Cannot approve a version with status "${version.status}"`, 422);
        }

        const [slot] = await tx.select().from(regionalBriefSlots).where(eq(regionalBriefSlots.id, version.slotId));
        if (!slot) throw new HttpError("regional_brief_slot_not_found", 404);

        if (slot.currentVersionId) {
          await tx
            .update(regionalBriefVersions)
            .set({ status: "superseded", updatedAt: new Date() })
            .where(eq(regionalBriefVersions.id, slot.currentVersionId));
        }

        const [updated] = await tx
          .update(regionalBriefVersions)
          .set({ status: "approved", reviewerId, reviewedAt: new Date(), updatedAt: new Date() })
          .where(eq(regionalBriefVersions.id, versionId))
          .returning();

        await tx
          .update(regionalBriefSlots)
          .set({ currentVersionId: versionId })
          .where(eq(regionalBriefSlots.id, slot.id));

        log.info("regional brief version approved", { slotId: slot.id, versionId });
        return updated!;
      });
    },

    async rejectVersion(versionId: string, reviewerId: string, reason: string) {
      const [version] = await db.select().from(regionalBriefVersions).where(eq(regionalBriefVersions.id, versionId));
      if (!version) throw new HttpError("regional_brief_version_not_found", 404);
      if (version.status !== "draft" && version.status !== "pending_review") {
        throw new HttpError(`Cannot reject a version with status "${version.status}"`, 422);
      }

      const [updated] = await db
        .update(regionalBriefVersions)
        .set({ status: "rejected", reviewerId, reviewedAt: new Date(), evidence: `${version.evidence}\n\nRejected: ${reason}`, updatedAt: new Date() })
        .where(eq(regionalBriefVersions.id, versionId))
        .returning();
      log.info("regional brief version rejected", { versionId, reason });
      return updated!;
    },

    async resolveRegionalBrief(params: {
      /** Alpha-2, alpha-3, or canonical country name. */
      countryIso: string;
      /** Free-text phrase or NAICS code — normalized internally. */
      industry?: string;
      workspaceId?: string;
    }): Promise<ResolvedBrief> {
      const country = await resolveCountry(params.countryIso);

      // Normalize industry phrase → NAICS code
      const industryNormalized = params.industry ? normalizeIndustry(params.industry) : null;
      const naicsCode = industryNormalized?.code ?? null;
      const industryInputWarning =
        params.industry && !industryNormalized
          ? `Industry phrase "${params.industry}" was not recognized; industry layer skipped.`
          : undefined;

      if (industryInputWarning) {
        log.warn("unrecognized industry phrase", { phrase: params.industry });
      }

      const layerOrder: RegionalBriefLayerType[] = ["global", "region", "country", "industry", "tenant", "outcome_learning"];
      const entries: ResolvedBriefEntry[] = [];

      for (const category of REGIONAL_BRIEF_FIELD_CATEGORIES) {
        let resolvedEntry: ResolvedBriefEntry | null = null;

        for (const layerType of layerOrder) {
          if (layerType === "industry" && !naicsCode) continue;
          if ((layerType === "tenant" || layerType === "outcome_learning") && !params.workspaceId) continue;

          // For region layer, use the sub-region code the country belongs to
          let regionCode: string | null = null;
          if (layerType === "region") {
            const [subRegion] = await db.select().from(regions).where(eq(regions.id, country.regionId));
            regionCode = subRegion?.code ?? null;
          }

          const scopeKey = buildScopeKey({
            layerType,
            regionCode,
            countryIso3: country.isoAlpha3,
            naicsCode,
            workspaceId: params.workspaceId ?? null,
            fieldCategory: category,
          });

          const [slot] = await db.select().from(regionalBriefSlots).where(eq(regionalBriefSlots.scopeKey, scopeKey));
          if (!slot?.currentVersionId) continue;

          const [version] = await db
            .select()
            .from(regionalBriefVersions)
            .where(eq(regionalBriefVersions.id, slot.currentVersionId));
          if (!version) continue;

          resolvedEntry = {
            fieldCategory: category,
            content: version.content,
            resolvedFromLayer: layerType,
            source: version.source,
            confidence: version.confidence,
            effectiveDate: version.effectiveDate.toISOString(),
            evidence: version.evidence,
            isStale: version.expiryDate ? version.expiryDate.getTime() < Date.now() : false,
          };
        }

        if (resolvedEntry) entries.push(resolvedEntry);
      }

      return {
        country: country.name,
        countryIso3: country.isoAlpha3,
        industry: naicsCode,
        industryName: naicsCode ? (NAICS_CODE_NAMES[naicsCode] ?? null) : null,
        ...(industryInputWarning ? { industryInputWarning } : {}),
        workspaceId: params.workspaceId ?? null,
        entries,
      };
    },

    async listSlots(filter: { layerType?: string; status?: string }) {
      if (filter.status) {
        const rows = await db
          .select({ slot: regionalBriefSlots })
          .from(regionalBriefSlots)
          .innerJoin(regionalBriefVersions, eq(regionalBriefSlots.currentVersionId, regionalBriefVersions.id))
          .where(
            filter.layerType
              ? and(eq(regionalBriefSlots.layerType, filter.layerType), eq(regionalBriefVersions.status, filter.status))
              : eq(regionalBriefVersions.status, filter.status)
          );
        return rows.map((row) => row.slot);
      }
      return db
        .select()
        .from(regionalBriefSlots)
        .where(filter.layerType ? eq(regionalBriefSlots.layerType, filter.layerType) : undefined);
    },

    async listVersions(slotId?: string, versionId?: string) {
      if (versionId) {
        return db.select().from(regionalBriefVersions).where(eq(regionalBriefVersions.id, versionId));
      }
      return db
        .select()
        .from(regionalBriefVersions)
        .where(eq(regionalBriefVersions.slotId, slotId!))
        .orderBy(regionalBriefVersions.version);
    },

    /** List all countries with their alpha-2, alpha-3 codes and region for the UI picker. */
    async listCountries() {
      return db
        .select({
          id: countries.id,
          name: countries.name,
          isoCode: countries.isoCode,
          isoAlpha3: countries.isoAlpha3,
          regionId: countries.regionId,
          currencyCode: countries.currencyCode,
        })
        .from(countries);
    },
  };
}
