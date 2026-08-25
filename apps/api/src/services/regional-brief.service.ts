import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import { HttpError } from "../utils/http.js";
import type { Env } from "../config/env.js";

const { regions, countries, regionalBriefSlots, regionalBriefVersions } = schema;

const log = createLogger("regional-brief.service");

/** global -> region -> country -> industry -> tenant -> outcome_learning, each overriding the one before it. */
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

export function isPlatformAdmin(
  config: Pick<Env, "PLATFORM_ADMIN_EMAILS">,
  email: string | undefined
): boolean {
  if (!email) return false;
  return config.PLATFORM_ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

export interface ScopeKeyInput {
  layerType: RegionalBriefLayerType;
  regionId?: string | null;
  countryId?: string | null;
  industry?: string | null;
  workspaceId?: string | null;
  fieldCategory: RegionalBriefFieldCategory;
}

export function buildScopeKey(input: ScopeKeyInput): string {
  const { layerType, fieldCategory } = input;
  switch (layerType) {
    case "global":
      return `global:${fieldCategory}`;
    case "region":
      return `region:${input.regionId}:${fieldCategory}`;
    case "country":
      return `country:${input.countryId}:${fieldCategory}`;
    case "industry":
      return `industry:${input.industry}:${fieldCategory}`;
    case "tenant":
      return `tenant:${input.workspaceId}:${input.countryId}:${fieldCategory}`;
    case "outcome_learning":
      return `outcome:${input.workspaceId}:${input.countryId}:${fieldCategory}`;
    default: {
      const _exhaustive: never = layerType;
      throw new HttpError(`Unknown layer type: ${_exhaustive}`, 400);
    }
  }
}

export interface CreateSlotInput {
  layerType: RegionalBriefLayerType;
  countryIso?: string;
  regionCode?: string;
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
  country: string;
  industry: string | null;
  workspaceId: string | null;
  entries: ResolvedBriefEntry[];
}

export function createRegionalBriefService(db: Db) {
  async function resolveRegionIdCountryId(input: CreateSlotInput) {
    let countryId: string | null = null;
    let regionId: string | null = null;
    if (input.countryIso) {
      const [country] = await db.select().from(countries).where(eq(countries.isoCode, input.countryIso));
      if (!country) throw new HttpError(`Unknown country ISO code: ${input.countryIso}`, 422);
      countryId = country.id;
      regionId = country.regionId;
    }
    if (input.regionCode) {
      const [region] = await db.select().from(regions).where(eq(regions.code, input.regionCode));
      if (!region) throw new HttpError(`Unknown region code: ${input.regionCode}`, 422);
      regionId = region.id;
    }
    return { regionId, countryId };
  }

  return {
    async findOrCreateSlot(input: CreateSlotInput) {
      const { regionId, countryId } = await resolveRegionIdCountryId(input);
      const scopeKey = buildScopeKey({
        layerType: input.layerType,
        regionId,
        countryId,
        industry: input.industry ?? null,
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
          industry: input.industry ?? null,
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

    async resolveRegionalBrief(params: { countryIso: string; industry?: string; workspaceId?: string }): Promise<ResolvedBrief> {
      const [country] = await db.select().from(countries).where(eq(countries.isoCode, params.countryIso));
      if (!country) throw new HttpError(`Unknown country ISO code: ${params.countryIso}`, 422);

      const layerOrder: RegionalBriefLayerType[] = ["global", "region", "country", "industry", "tenant", "outcome_learning"];
      const entries: ResolvedBriefEntry[] = [];

      for (const category of REGIONAL_BRIEF_FIELD_CATEGORIES) {
        let resolvedEntry: ResolvedBriefEntry | null = null;

        for (const layerType of layerOrder) {
          if (layerType === "industry" && !params.industry) continue;
          if ((layerType === "tenant" || layerType === "outcome_learning") && !params.workspaceId) continue;

          const scopeKey = buildScopeKey({
            layerType,
            regionId: country.regionId,
            countryId: country.id,
            industry: params.industry ?? null,
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
        country: params.countryIso,
        industry: params.industry ?? null,
        workspaceId: params.workspaceId ?? null,
        entries,
      };
    },

    async listSlots(filter: { layerType?: string; status?: string }) {
      // status filters on the slot's current version's status if provided; omit the join if not.
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
  };
}
