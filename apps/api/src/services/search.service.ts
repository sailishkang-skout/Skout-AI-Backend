// cSpell:ignore opensearch OPENSEARCH
import { seniorityEnum, type SearchProspectsRequest, type SearchProspectsResponse } from "@skout/shared";
import {
  buildDemoCorpus,
  filterDemoCorpus,
  bulkCreateProspects,
  getProspectById as osGetById,
  searchProspects as osSearch,
  type OpenSearchConfig,
  type ProspectDocument,
  type SearchFilters,
} from "@skout/opensearch";
import { createLogger } from "@skout/observability";
import type { Db } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { enabledVendors, searchVendors, toProspectDocument } from "./vendor-search.service.js";
import { 
  listSignalsForEntities, 
  computeSignalStackScore, 
  signalStackWeightsFromEnv,
  type SignalStackScore 
} from "./signal.service.js";

/** Seniority tiers treated as a reachable decision-maker (matches signal.service.ts) */
const DECISION_MAKER_SENIORITIES = new Set([
  "founder",
  "co_founder",
  "ceo",
  "c_level",
  "vp",
  "director",
  "head",
]);

const log = createLogger("search.service");

let cachedDemoCorpus: ProspectDocument[] | null = null;

function demoCorpus(env: Env): ProspectDocument[] {
  if (!cachedDemoCorpus) {
    cachedDemoCorpus = buildDemoCorpus(env.DEMO_CORPUS_SIZE);
  }
  return cachedDemoCorpus;
}

function osConfig(env: Env): OpenSearchConfig | null {
  if (!env.OPENSEARCH_URL) return null;
  return {
    url: env.OPENSEARCH_URL,
    username: env.OPENSEARCH_USERNAME,
    password: env.OPENSEARCH_PASSWORD,
    index: env.OPENSEARCH_INDEX,
  };
}

function toFilters(body: SearchProspectsRequest): SearchFilters {
  const f = body.filters ?? {};
  return {
    query: body.query,
    fullName: f.fullName,
    jobTitle: f.jobTitle,
    department: f.department,
    seniority: f.seniority,
    jobFunction: f.jobFunction,
    emailAvailable: f.emailAvailable,
    phoneAvailable: f.phoneAvailable,
    linkedInAvailable: f.linkedInAvailable,
    minYearsAtCompany: f.minYearsAtCompany,
    minYearsInRole: f.minYearsInRole,
    minTotalYearsExperience: f.minTotalYearsExperience,
    previousCompany: f.previousCompany,
    minFoundedYear: f.minFoundedYear,
    maxFoundedYear: f.maxFoundedYear,
    minHeadcountGrowth: f.minHeadcountGrowth,
    companyEmailProvider: f.companyEmailProvider,
    minIntentScore: f.minIntentScore,
    excludeDuplicates: f.excludeDuplicates,
    maxPerCompany: f.maxPerCompany,
    contactSignals: f.contactSignals,
    companyName: f.companyName,
    companyDomain: f.companyDomain,
    keyword: f.keyword,
    industry: f.industry,
    subIndustry: f.subIndustry,
    country: f.country,
    state: f.state,
    city: f.city,
    minEmployees: f.minEmployees,
    maxEmployees: f.maxEmployees,
    companyStage: f.companyStage,
    lastFundingRound: f.lastFundingRound,
    minRevenue: f.minRevenue,
    maxRevenue: f.maxRevenue,
    currentlyHiring: f.currentlyHiring,
    hiringDepartments: f.hiringDepartments,
    companySignals: f.companySignals,
    industries: f.industries,
    countries: f.countries,
    seniorities: f.seniorities,
    employeeBuckets: f.employeeBuckets,
    tech: f.tech,
    signal: f.signal,
  };
}

const VALID_SENIORITIES = new Set(seniorityEnum.options);

function recordTypeFor(doc: ProspectDocument): "person" | "company" {
  if (doc.title || doc.email || doc.fullName) return "person";
  return "company";
}

function mapDocToSummary(doc: ProspectDocument, signalStackScore?: SignalStackScore) {
  return {
    prospectId: doc.prospectId,
    companyId: doc.companyId,
    fullName: doc.fullName ?? doc.companyName ?? "Unknown",
    title: doc.title ?? "",
    seniority: VALID_SENIORITIES.has(doc.seniority as (typeof seniorityEnum.options)[number])
      ? (doc.seniority as (typeof seniorityEnum.options)[number])
      : ("unknown" as const),
    country: doc.country ?? "",
    industry: doc.industry ?? "",
    companyDomain: doc.companyDomain,
    companyName: doc.companyName,
    recordType: recordTypeFor(doc),
    employeeCount: doc.employeeCount,
    // Fit score: ICP/firmographic match (original icpScore)
    fitScore: doc.icpScore,
    // Timing score: signal-stacking score
    timingScore: signalStackScore?.score,
    // Keep existing fields for backward compatibility temporarily
    icpScore: doc.icpScore,
    intentScore: doc.intentScore,
    painPoints: doc.painPoints,
    outreachReadiness: doc.outreachReadiness,
    signals: doc.signals?.slice(0, 5),
    techStack: doc.techStack?.slice(0, 6),
    updatedAt: doc.updatedAt,
  };
}

function mapDocToDetail(doc: ProspectDocument, signalStackScore?: SignalStackScore) {
  return {
    ...mapDocToSummary(doc, signalStackScore),
    signals: doc.signals,
    techStack: doc.techStack,
    email: doc.email,
    phone: doc.phone,
    linkedinUrl: doc.linkedinUrl,
    department: doc.department,
    jobFunction: doc.jobFunction,
    subIndustry: doc.subIndustry,
    state: doc.state,
    city: doc.city,
    employeeBucket: doc.employeeBucket,
    companyStage: doc.companyStage,
    annualRevenue: doc.annualRevenue,
    lastFundingRound: doc.lastFundingRound,
    lastFundingDate: doc.lastFundingDate,
    totalFunding: doc.totalFunding,
    currentlyHiring: doc.currentlyHiring,
    foundedYear: doc.foundedYear,
    headcountGrowth: doc.headcountGrowth,
    companyEmailProvider: doc.companyEmailProvider,
    yearsAtCompany: doc.yearsAtCompany,
    yearsInRole: doc.yearsInRole,
    totalYearsExperience: doc.totalYearsExperience,
    previousCompany: doc.previousCompany,
  };
}

function normalizeSeniority(value: unknown): (typeof seniorityEnum.options)[number] {
  const raw = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  return VALID_SENIORITIES.has(raw as (typeof seniorityEnum.options)[number])
    ? (raw as (typeof seniorityEnum.options)[number])
    : ("unknown" as const);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Build a prospect detail from a stored activation snapshot (LinkedIn capture / manual add). */
export function buildDetailFromSnapshot(
  prospectId: string,
  companyId: string,
  snapshot: Record<string, unknown>,
  updatedAt?: string
) {
  const fullName = str(snapshot.fullName) ?? str(snapshot.companyName) ?? "Unknown";
  const company = (snapshot.company as Record<string, unknown> | undefined) ?? undefined;
  return {
    prospectId,
    companyId,
    fullName,
    title: str(snapshot.title) ?? str(snapshot.headline) ?? "",
    seniority: normalizeSeniority(snapshot.seniority),
    country: str(snapshot.country) ?? "",
    industry: str(snapshot.industry) ?? str(company?.industry) ?? "",
    companyDomain: str(snapshot.companyDomain) ?? "",
    companyName: str(snapshot.companyName) ?? str(company?.name),
    recordType: "person" as const,
    employeeCount: typeof snapshot.employeeCount === "number" ? snapshot.employeeCount : undefined,
    updatedAt: updatedAt ?? new Date().toISOString(),
    email: str(snapshot.email),
    phone: str(snapshot.phone),
    linkedinUrl: str(snapshot.linkedinUrl),
    city: str(snapshot.city),
    state: str(snapshot.state),
  };
}

/**
 * Search service — OpenSearch corpus with demo fallback when OPENSEARCH_URL unset.
 */
export class SearchService {
  constructor(private readonly env: Env, private readonly db: Db) {}

  /**
   * §8.2 SS-04 — same per-hit signal-stack computation `searchProspects` already does for list
   * results, but for a single doc, so `timingScore` isn't silently undefined on detail/lookup
   * responses just because they take a different code path through this service.
   */
  private async computeStackScoreForDoc(doc: ProspectDocument): Promise<SignalStackScore | undefined> {
    if (!this.db || typeof this.db.select !== "function") return undefined;

    const entityIds = [doc.prospectId];
    if (doc.companyId && doc.companyId !== doc.prospectId) entityIds.push(doc.companyId);
    const byEntity = await listSignalsForEntities(this.db, entityIds);
    const mergedSignals = [
      ...(byEntity.get(doc.prospectId) ?? []),
      ...(doc.companyId && doc.companyId !== doc.prospectId ? (byEntity.get(doc.companyId) ?? []) : []),
    ];
    const reachableDecisionMaker = Boolean(
      doc.seniority && DECISION_MAKER_SENIORITIES.has(doc.seniority.toLowerCase())
    );
    return computeSignalStackScore(mergedSignals, {
      weights: signalStackWeightsFromEnv(this.env),
      reachableDecisionMaker,
    });
  }

  /** True when this id resolves to a real OpenSearch/demo doc (not the hardcoded fallback). */
  async findExistingProspect(prospectId: string) {
    const cfg = osConfig(this.env);
    if (cfg) {
      const doc = await osGetById(cfg, prospectId).catch(() => null);
      if (doc) return mapDocToDetail(doc, await this.computeStackScoreForDoc(doc));
    }
    const doc = demoCorpus(this.env).find((row) => row.prospectId === prospectId);
    return doc ? mapDocToDetail(doc, await this.computeStackScoreForDoc(doc)) : null;
  }

  async searchProspects(body: SearchProspectsRequest): Promise<SearchProspectsResponse> {
    const page = body.page ?? 1;
    const pageSize = body.pageSize ?? 25;
    const cfg = osConfig(this.env);

    // Real data: when any vendor key is configured, serve real people only — from our own
    // index first (free), topping up from Wiza/ContactOut/Datagma when the index is thin.
    if (enabledVendors(this.env).length > 0) {
      return this.vendorBackedSearch(body, page, pageSize, cfg);
    }

    if (cfg) {
      try {
        const res = await osSearch(cfg, toFilters(body), page, pageSize);
        log.debug("prospect search completed", {
          page,
          pageSize,
          total: res.total,
          source: "opensearch",
        });

        let results;
        // Only load signals and compute stack scores if this.db is a valid database instance
        if (this.db && typeof this.db.select === "function") {
          // Batch load all signals for entities in search results to compute signal stack scores
          const entityIds = new Set<string>();
          res.hits.forEach(hit => {
            entityIds.add(hit.prospectId);
            if (hit.companyId && hit.companyId !== hit.prospectId) {
              entityIds.add(hit.companyId);
            }
          });

          // Compute which entities have reachable decision-makers
          const reachableDecisionMakerByEntity = new Set<string>();
          res.hits.forEach(hit => {
            if (hit.seniority && DECISION_MAKER_SENIORITIES.has(hit.seniority.toLowerCase())) {
              reachableDecisionMakerByEntity.add(hit.companyId);
            }
          });

          // Load all signals from database
          const byEntity = await listSignalsForEntities(this.db, Array.from(entityIds));
          const weights = signalStackWeightsFromEnv(this.env);

          // Compute signal stack score for each hit
          results = res.hits.map(hit => {
            // Merge prospect and company signals
            const mergedSignals = [
              ...(byEntity.get(hit.prospectId) ?? []),
              ...(hit.companyId && hit.companyId !== hit.prospectId ? (byEntity.get(hit.companyId) ?? []) : []),
            ];
            // Compute stack score
            const stackScore = computeSignalStackScore(mergedSignals, {
              weights,
              reachableDecisionMaker: reachableDecisionMakerByEntity.has(hit.companyId),
            });
            return mapDocToSummary(hit, stackScore);
          });
        } else {
          // Fallback for tests/demo mode where database isn't fully initialized
          log.debug("Database not available, skipping signal stack score calculation", { page, pageSize });
          results = res.hits.map(hit => mapDocToSummary(hit));
        }

        return {
          results,
          total: res.total,
          page,
          pageSize,
          cached: false,
          source: "opensearch" as const,
        };
      } catch (err) {
        log.error("prospect search failed", err, { page, pageSize });
        throw new HttpError(
          "search_index_unavailable",
          502,
          err instanceof Error ? err.message : "OpenSearch query failed"
        );
      }
    }

    return this.demoSearch(body, page, pageSize);
  }

  /**
   * Index-first, vendor-top-up search. Stored vendor docs (dataSource "vendor") cost nothing to
   * serve. Only when the index can't fill the requested page do we spend vendor credits (page N
   * asks ContactOut for page N), and every result is saved create-only so later searches — and
   * deeper pages — are answered from our own index. Index order is oldest-first so pages stay
   * stable while the index grows.
   */
  private async vendorBackedSearch(
    body: SearchProspectsRequest,
    page: number,
    pageSize: number,
    cfg: OpenSearchConfig | null
  ): Promise<SearchProspectsResponse> {
    const filters = toFilters(body);
    const storedFilters = { ...filters, dataSource: "vendor", stableOrder: true };
    const lookup = async () => {
      if (!cfg) return { hits: [] as ProspectDocument[], total: 0 };
      try {
        return await osSearch(cfg, storedFilters, page, pageSize);
      } catch (err) {
        log.error("stored vendor-prospect lookup failed", err, { page, pageSize });
        return { hits: [] as ProspectDocument[], total: 0 };
      }
    };

    let stored = await lookup();
    if (stored.hits.length >= pageSize) {
      return { results: stored.hits.map((h) => mapDocToSummary(h)), total: stored.total, page, pageSize, cached: false, source: "opensearch" };
    }

    const outcome = await searchVendors(this.env, filters, pageSize, page);
    if (outcome.attempted.length > 0 && outcome.failed.length === outcome.attempted.length && stored.hits.length === 0) {
      throw new HttpError(
        "vendor_search_unavailable",
        502,
        `Prospect data providers failed: ${outcome.failed.map((f) => `${f.vendor} (${f.error})`).join("; ")}`
      );
    }

    const fresh = outcome.people.map(toProspectDocument);
    let hits = stored.hits;
    let total = Math.max(stored.total, outcome.total ?? 0);
    if (fresh.length > 0) {
      if (cfg) {
        try {
          const r = await bulkCreateProspects(cfg, fresh);
          log.info("vendor prospects saved", { ...r, vendors: outcome.attempted, page });
          stored = await lookup(); // now includes the new docs, in stable order
          hits = stored.hits;
        } catch (err) {
          log.error("saving vendor prospects failed", err);
        }
      }
      if (hits.length === 0) hits = fresh.slice(0, pageSize); // no index / save failed: serve directly
      total = Math.max(total, stored.total, hits.length);
    }

    return {
      results: hits.map((h) => mapDocToSummary(h)),
      total,
      page,
      pageSize,
      cached: false,
      source: fresh.length > 0 ? "vendor" : "opensearch",
    };
  }

  async getProspectById(prospectId: string) {
    const cfg = osConfig(this.env);
    if (cfg) {
      const doc = await osGetById(cfg, prospectId).catch(() => null);
      if (doc) return mapDocToDetail(doc, await this.computeStackScoreForDoc(doc));
    }

    const doc = demoCorpus(this.env).find((row) => row.prospectId === prospectId);
    if (doc) return mapDocToDetail(doc, await this.computeStackScoreForDoc(doc));

    return null;
  }

  private demoSearch(body: SearchProspectsRequest, page: number, pageSize: number): SearchProspectsResponse {
    const filtered = filterDemoCorpus(demoCorpus(this.env), toFilters(body));
    // Compute which entities have reachable decision-makers for signal stack consistency
    const reachableDecisionMakerByEntity = new Set<string>();
    filtered.forEach(hit => {
      if (hit.seniority && DECISION_MAKER_SENIORITIES.has(hit.seniority.toLowerCase())) {
        reachableDecisionMakerByEntity.add(hit.companyId);
      }
    });
    const weights = signalStackWeightsFromEnv(this.env);
    const start = (page - 1) * pageSize;
    const slice = filtered.slice(start, start + pageSize);
    return {
      results: slice.map(hit => {
        // Compute dummy stack score for consistency with OpenSearch path
        const stackScore = computeSignalStackScore([], {
          weights,
          reachableDecisionMaker: reachableDecisionMakerByEntity.has(hit.companyId),
        });
        return mapDocToSummary(hit, stackScore);
      }),
      total: filtered.length,
      page,
      pageSize,
      cached: false,
      source: "demo" as const,
    };
  }
}

export function createSearchService(env: Env, db: Db) {
  return new SearchService(env, db);
}