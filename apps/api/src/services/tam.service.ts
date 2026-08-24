import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import {
  aggregateDemoCorpus,
  aggregateProspects,
  buildDemoCorpus,
  type OpenSearchConfig,
  type ProspectDocument,
  type SearchFilters,
  type SegmentBucket,
} from "@skout/opensearch";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { getWorkspaceIcp } from "./icp.service.js";
import { createSmartList, type SmartListRecord } from "./smart-list.service.js";

const { tams, prospectActivations, enrichmentJobs, sequenceEnrollments, inboxThreads, companies, deals } = schema;

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md for the full audit and rationale; one of the 9
 * confirmed instances listed there (formalized in Task 17).
 *   - Tables touched directly: deals (owned by apps/crm) - read only
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: TAM coverage-funnel computation reads deals alongside prospect/enrichment/
 *     sequence/OpenSearch data in one aggregation pass; splitting the deals read into a
 *     separate HTTP call into apps/crm would fragment a single-transaction-shaped read into
 *     two round trips for no correctness benefit
 *   - Review date: revisit once apps/crm's internal API surface exists (Wave 2)
 */

export interface TamFilterConfig {
  industries?: string[];
  countries?: string[];
  seniorities?: string[];
  minEmployees?: number;
  maxEmployees?: number;
}

export interface CoverageFunnel {
  total: number;
  activated: number;
  enriched: number;
  contacted: number;
  replied: number;
  deal: number;
}

export interface TamDto {
  id: string;
  workspaceId: string;
  name: string;
  filterConfig: TamFilterConfig | null;
  totalCount: number;
  segmentBreakdown: SegmentBucket[];
  coverage: CoverageFunnel;
  lastComputedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const EMPTY_COVERAGE: CoverageFunnel = { total: 0, activated: 0, enriched: 0, contacted: 0, replied: 0, deal: 0 };

function toDto(row: typeof tams.$inferSelect): TamDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    filterConfig: (row.filterConfig as TamFilterConfig | null) ?? null,
    totalCount: row.totalCount,
    segmentBreakdown: (row.segmentBreakdown as SegmentBucket[]) ?? [],
    coverage: (row.coverage as CoverageFunnel) ?? EMPTY_COVERAGE,
    lastComputedAt: row.lastComputedAt ? row.lastComputedAt.toISOString() : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** ICP config → corpus search filters. Only the dimensions the TAM breakdown reports on
 * (industry/size/geo) plus seniority; `titles`/`keywords`/`productDescription` drive AI
 * scoring, not corpus membership, so they're intentionally not part of a TAM's match set. */
function icpToFilterConfig(icp: { industries?: string[]; countries?: string[]; seniorities?: string[]; minEmployees?: number; maxEmployees?: number }): TamFilterConfig {
  return {
    industries: icp.industries,
    countries: icp.countries,
    seniorities: icp.seniorities,
    minEmployees: icp.minEmployees,
    maxEmployees: icp.maxEmployees,
  };
}

function toSearchFilters(cfg: TamFilterConfig): SearchFilters {
  return {
    industries: cfg.industries,
    countries: cfg.countries,
    seniorities: cfg.seniorities,
    minEmployees: cfg.minEmployees,
    maxEmployees: cfg.maxEmployees,
  };
}

function osConfig(env: Env): OpenSearchConfig | null {
  if (!env.OPENSEARCH_URL) return null;
  return { url: env.OPENSEARCH_URL, username: env.OPENSEARCH_USERNAME, password: env.OPENSEARCH_PASSWORD, index: env.OPENSEARCH_INDEX };
}

let cachedDemoCorpus: ProspectDocument[] | null = null;
function demoCorpus(env: Env): ProspectDocument[] {
  if (!cachedDemoCorpus) cachedDemoCorpus = buildDemoCorpus(env.DEMO_CORPUS_SIZE);
  return cachedDemoCorpus;
}

async function runAggregate(env: Env, filters: SearchFilters) {
  const cfg = osConfig(env);
  if (!cfg) return aggregateDemoCorpus(demoCorpus(env), filters);
  try {
    return await aggregateProspects(cfg, filters);
  } catch (err) {
    // aggregateProspects/osFetch throws a plain Error on any non-2xx OpenSearch response
    // (missing index, bad field mapping, auth) — left as-is it becomes an opaque 500 with no
    // hint to the caller. Wrapping in HttpError still gets full detail logged server-side
    // (app.ts's error handler logs HttpErrors at warn with the original message) while giving
    // the client something actionable instead of "An internal server error occurred."
    throw new HttpError("Could not reach the search backend to compute this TAM — try again in a moment.", 502, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Does an activation's captured snapshot fall inside the TAM's industry/country/employee filter? */
function matchesFilterConfig(snapshot: Record<string, unknown>, cfg: TamFilterConfig): boolean {
  const industry = typeof snapshot.industry === "string" ? snapshot.industry : undefined;
  const country = typeof snapshot.country === "string" ? snapshot.country : undefined;
  const employeeCount = typeof snapshot.employeeCount === "number" ? snapshot.employeeCount : undefined;

  if (cfg.industries?.length && (!industry || !cfg.industries.includes(industry))) return false;
  if (cfg.countries?.length && (!country || !cfg.countries.includes(country))) return false;
  if (cfg.minEmployees != null && (employeeCount == null || employeeCount < cfg.minEmployees)) return false;
  if (cfg.maxEmployees != null && (employeeCount == null || employeeCount > cfg.maxEmployees)) return false;
  return true;
}

/**
 * R12.2 — workspace-local coverage funnel: of this workspace's activated prospects that fall
 * inside the TAM's segment, how many progressed through enrichment/sequence/reply/deal.
 * Computed from Postgres (not the corpus) since this is inherently workspace-scoped data.
 */
async function computeCoverage(db: Db, workspaceId: string, filterConfig: TamFilterConfig, totalCount: number): Promise<CoverageFunnel> {
  const activations = await db
    .select({ id: prospectActivations.id, prospectId: prospectActivations.prospectId, companyId: prospectActivations.companyId, snapshot: prospectActivations.snapshot })
    .from(prospectActivations)
    .where(eq(prospectActivations.workspaceId, workspaceId));

  const inTam = activations.filter((a) => matchesFilterConfig((a.snapshot as Record<string, unknown>) ?? {}, filterConfig));
  if (inTam.length === 0) return { ...EMPTY_COVERAGE, total: totalCount };

  const prospectIds = inTam.map((a) => a.prospectId);
  const companyIds = [...new Set(inTam.map((a) => a.companyId))];

  const [enrichedRows, sequencedRows, threadRows, dealCompanyRows] = await Promise.all([
    db
      .select({ prospectId: enrichmentJobs.prospectId })
      .from(enrichmentJobs)
      .where(and(eq(enrichmentJobs.workspaceId, workspaceId), eq(enrichmentJobs.status, "completed"), inArray(enrichmentJobs.prospectId, prospectIds))),
    db
      .select({ prospectId: sequenceEnrollments.prospectId })
      .from(sequenceEnrollments)
      .where(and(eq(sequenceEnrollments.workspaceId, workspaceId), inArray(sequenceEnrollments.prospectId, prospectIds))),
    db
      .select({ prospectId: inboxThreads.prospectId })
      .from(inboxThreads)
      .where(and(eq(inboxThreads.workspaceId, workspaceId), inArray(inboxThreads.prospectId, prospectIds))),
    db
      .select({ sourceProspectCompanyId: companies.sourceProspectCompanyId })
      .from(deals)
      .innerJoin(companies, eq(companies.id, deals.companyId))
      .where(and(eq(deals.workspaceId, workspaceId), inArray(companies.sourceProspectCompanyId, companyIds))),
  ]);

  const enrichedSet = new Set(enrichedRows.map((r) => r.prospectId));
  const contactedSet = new Set(sequencedRows.map((r) => r.prospectId));
  const repliedSet = new Set(
    threadRows.filter((r) => r.prospectId).map((r) => r.prospectId as string)
  );
  const dealCompanySet = new Set(dealCompanyRows.map((r) => r.sourceProspectCompanyId).filter((v): v is string => v != null));

  return {
    total: totalCount,
    activated: inTam.length,
    enriched: inTam.filter((a) => enrichedSet.has(a.prospectId)).length,
    contacted: inTam.filter((a) => contactedSet.has(a.prospectId)).length,
    replied: inTam.filter((a) => repliedSet.has(a.prospectId)).length,
    deal: inTam.filter((a) => dealCompanySet.has(a.companyId)).length,
  };
}

export async function listTams(db: Db, workspaceId: string): Promise<TamDto[]> {
  const rows = await db.select().from(tams).where(eq(tams.workspaceId, workspaceId));
  return rows.map(toDto);
}

export async function getTam(db: Db, workspaceId: string, id: string): Promise<TamDto | null> {
  const [row] = await db.select().from(tams).where(and(eq(tams.id, id), eq(tams.workspaceId, workspaceId))).limit(1);
  return row ? toDto(row) : null;
}

/** R12.1 create + R12.2 initial coverage. `filterConfig` override, or the current workspace ICP. */
export async function createTam(
  db: Db,
  env: Env,
  workspaceId: string,
  input: { name: string; filterConfig?: TamFilterConfig },
  createdBy?: string
): Promise<TamDto> {
  if (!input.name?.trim()) throw new HttpError("name is required", 422);

  const effectiveFilter = input.filterConfig ?? icpToFilterConfig(await getWorkspaceIcp(db, workspaceId));
  const { total, segments } = await runAggregate(env, toSearchFilters(effectiveFilter));
  const coverage = await computeCoverage(db, workspaceId, effectiveFilter, total);

  const [row] = await db
    .insert(tams)
    .values({
      workspaceId,
      name: input.name.trim(),
      filterConfig: input.filterConfig ?? null,
      totalCount: total,
      segmentBreakdown: segments,
      coverage,
      lastComputedAt: new Date(),
      createdBy: createdBy ?? null,
    })
    .returning();
  return toDto(row!);
}

/** R12.1/R12.2 — re-run both the corpus aggregation and the coverage funnel together. */
export async function recomputeTam(db: Db, env: Env, workspaceId: string, id: string): Promise<TamDto> {
  const existing = await getTam(db, workspaceId, id);
  if (!existing) throw new HttpError("tam_not_found", 404);

  const effectiveFilter = existing.filterConfig ?? icpToFilterConfig(await getWorkspaceIcp(db, workspaceId));
  const { total, segments } = await runAggregate(env, toSearchFilters(effectiveFilter));
  const coverage = await computeCoverage(db, workspaceId, effectiveFilter, total);

  const [row] = await db
    .update(tams)
    .set({ totalCount: total, segmentBreakdown: segments, coverage, lastComputedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(tams.id, id), eq(tams.workspaceId, workspaceId)))
    .returning();
  return toDto(row!);
}

/**
 * R12.3 — "drill into a segment as a live, filtered dynamic list." Rather than a bespoke
 * TAM-specific export/push-to-sequence path, this narrows the TAM's filter to one segment
 * (or leaves it as the whole TAM when no dimension/value given) and hands it to the existing
 * smart-list pipeline — which already supports run, CSV export, and pushing into a sequence.
 */
export async function drillIntoTamSegment(
  db: Db,
  workspaceId: string,
  id: string,
  input: { name: string; dimension?: "industry" | "size" | "geo"; value?: string }
): Promise<SmartListRecord> {
  const tam = await getTam(db, workspaceId, id);
  if (!tam) throw new HttpError("tam_not_found", 404);

  const baseFilter = tam.filterConfig ?? icpToFilterConfig(await getWorkspaceIcp(db, workspaceId));
  const filters = toSearchFilters(baseFilter);
  if (input.dimension === "industry" && input.value) filters.industries = [input.value];
  if (input.dimension === "geo" && input.value) filters.countries = [input.value];
  // "size" segments come from employeeBucket, which the search filter model doesn't expose as
  // a discrete term filter today — that segment still drills in as the whole TAM's filter.

  return createSmartList(db, workspaceId, input.name, filters);
}
