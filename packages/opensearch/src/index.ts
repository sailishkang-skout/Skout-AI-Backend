import { buildDemoCorpus, filterDemoCorpus, postProcessSearchHits } from "./demo-corpus.js";

/** Default OpenSearch index for the global prospect corpus. */
export const PROSPECTS_INDEX = process.env.OPENSEARCH_INDEX ?? "prospects";

export { aggregateDemoCorpus, buildDemoCorpus, filterDemoCorpus, postProcessSearchHits } from "./demo-corpus.js";

export interface OpenSearchConfig {
  url: string;
  username?: string;
  password?: string;
  index?: string;
  timeoutMs?: number;
}

export interface ProspectDocument {
  prospectId: string;
  companyId: string;
  fullName?: string;
  title?: string;
  seniority?: string;
  department?: string;
  jobFunction?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  companyDomain: string;
  companyName?: string;
  industry?: string;
  subIndustry?: string;
  country?: string;
  state?: string;
  city?: string;
  employeeCount?: number;
  employeeBucket?: string;
  companyStage?: string;
  annualRevenue?: number;
  lastFundingRound?: string;
  lastFundingDate?: string;
  totalFunding?: number;
  currentlyHiring?: boolean;
  /** Departments with open roles (from scraper hiringByDept keys). */
  hiringDepartments?: string[];
  yearsAtCompany?: number;
  yearsInRole?: number;
  totalYearsExperience?: number;
  foundedYear?: number;
  headcountGrowth?: number;
  companyEmailProvider?: string;
  previousCompany?: string;
  techStack?: { category: string; technology: string }[];
  signals?: { type: string; observedAt: string; detail?: string }[];
  icpScore?: number;
  intentScore?: number;
  painPoints?: string[];
  outreachReadiness?: string;
  /** "vendor" = real person saved from a live data-vendor search; absent = seeded/demo data. */
  dataSource?: string;
  /** Which vendors returned this person (wiza | contactout | datagma). */
  dataVendors?: string[];
  headline?: string;
  location?: string;
  skills?: string[];
  schools?: string[];
  updatedAt: string;
}

export interface SearchFilters {
  query?: string;
  /** Restrict to documents with this dataSource (e.g. "vendor" = real people only), or any of several. */
  dataSource?: string | string[];
  /** Oldest-first order so pages stay stable while new documents are added (vendor pagination). */
  stableOrder?: boolean;
  // Contact
  fullName?: string;
  jobTitle?: string;
  department?: string;
  seniority?: string;
  jobFunction?: string;
  emailAvailable?: boolean;
  phoneAvailable?: boolean;
  linkedInAvailable?: boolean;
  // Experience
  minYearsAtCompany?: number;
  minYearsInRole?: number;
  minTotalYearsExperience?: number;
  previousCompany?: string;
  minFoundedYear?: number;
  maxFoundedYear?: number;
  minHeadcountGrowth?: number;
  companyEmailProvider?: string;
  minIntentScore?: number;
  excludeDuplicates?: boolean;
  maxPerCompany?: number;
  // Activity signals (multi-select OR)
  contactSignals?: string[];
  // Company — basic
  companyName?: string;
  companyDomain?: string;
  keyword?: string;
  industry?: string;
  subIndustry?: string;
  country?: string;
  state?: string;
  city?: string;
  minEmployees?: number;
  maxEmployees?: number;
  // Multi-select OR variants (R12.1 — ICP config is multi-select; search filters above stay
  // single-value for the existing search UI). Applied alongside, not instead of, the above.
  industries?: string[];
  countries?: string[];
  seniorities?: string[];
  employeeBuckets?: string[];
  // Company — stage & funding
  companyStage?: string;
  lastFundingRound?: string;
  minRevenue?: number;
  maxRevenue?: number;
  // Hiring
  currentlyHiring?: boolean;
  hiringDepartments?: string[];
  // Company signals (multi-select OR)
  companySignals?: string[];
  // Tech / intent (existing)
  tech?: string;
  signal?: string;
}

export interface SearchResult {
  hits: ProspectDocument[];
  total: number;
}

function authHeader(cfg: OpenSearchConfig): Record<string, string> {
  if (cfg.username && cfg.password) {
    const token = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }
  return {};
}

async function osFetch<T>(
  cfg: OpenSearchConfig,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = `${cfg.url.replace(/\/$/, "")}${path}`;
  // Hosted clusters (e.g. Bonsai) cap concurrent requests and answer 429 when exceeded. That is
  // transient, so back off briefly and retry instead of failing the caller (a failed lookup
  // would otherwise surface as "prospect_not_found"). Request bodies are strings, so resending is safe.
  let res!: Response;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...authHeader(cfg),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 15000),
    });
    if (res.status !== 429 || attempt === 4) break;
    await res.text().catch(() => "");
    await new Promise((r) => setTimeout(r, 200 * 2 ** attempt + Math.random() * 150));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenSearch ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Create index if missing (idempotent). */
export async function ensureProspectsIndex(cfg: OpenSearchConfig): Promise<void> {
  const index = cfg.index ?? PROSPECTS_INDEX;
  const head = await fetch(`${cfg.url.replace(/\/$/, "")}/${index}`, {
    method: "HEAD",
    headers: authHeader(cfg),
  });
  if (head.status === 200) return;

  await osFetch(cfg, `/${index}`, {
    method: "PUT",
    body: JSON.stringify({
      mappings: {
        properties: {
          prospectId: { type: "keyword" },
          companyId: { type: "keyword" },
          fullName: { type: "text" },
          title: { type: "text" },
          seniority: { type: "keyword" },
          department: { type: "keyword" },
          jobFunction: { type: "keyword" },
          email: { type: "keyword" },
          phone: { type: "keyword" },
          linkedinUrl: { type: "keyword" },
          companyDomain: { type: "keyword" },
          companyName: { type: "text" },
          industry: { type: "keyword" },
          subIndustry: { type: "keyword" },
          country: { type: "keyword" },
          state: { type: "keyword" },
          city: { type: "text" },
          employeeCount: { type: "integer" },
          // `.keyword` subfield so TAM terms aggs work on both this mapping and
          // dynamically mapped text fields (Bonsai default for unmapped strings).
          employeeBucket: { type: "keyword", fields: { keyword: { type: "keyword", ignore_above: 256 } } },
          companyStage: { type: "keyword" },
          annualRevenue: { type: "long" },
          lastFundingRound: { type: "keyword" },
          lastFundingDate: { type: "date" },
          totalFunding: { type: "long" },
          currentlyHiring: { type: "boolean" },
          yearsAtCompany: { type: "float" },
          yearsInRole: { type: "float" },
          totalYearsExperience: { type: "float" },
          foundedYear: { type: "integer" },
          headcountGrowth: { type: "float" },
          companyEmailProvider: { type: "keyword" },
          previousCompany: { type: "text" },
          techStack: { type: "nested" },
          signals: { type: "nested" },
          icpScore: { type: "integer" },
          intentScore: { type: "integer" },
          painPoints: { type: "keyword" },
          outreachReadiness: { type: "keyword" },
          dataSource: { type: "keyword" },
          dataVendors: { type: "keyword" },
          ...CAPTURE_FIELD_MAPPINGS,
          updatedAt: { type: "date" },
        },
      },
    }),
  });
}

/** Fields added for LinkedIn captures; also put on indexes created before they existed. */
const CAPTURE_FIELD_MAPPINGS = {
  headline: { type: "text" },
  location: { type: "text" },
  skills: { type: "text" },
  schools: { type: "text" },
} as const;

/** Adds the capture fields to an existing index's mapping. Safe to call repeatedly. */
export async function ensureCaptureFieldMappings(cfg: OpenSearchConfig): Promise<void> {
  const index = cfg.index ?? PROSPECTS_INDEX;
  await osFetch(cfg, `/${index}/_mapping`, {
    method: "PUT",
    body: JSON.stringify({ properties: CAPTURE_FIELD_MAPPINGS }),
  });
}

/** Bulk upsert documents (idempotent by prospectId, or by `idOf` when given). */
export async function bulkUpsertProspects(
  cfg: OpenSearchConfig,
  docs: ProspectDocument[],
  idOf: (doc: ProspectDocument) => string = (doc) => doc.prospectId
): Promise<{ ingested: number; failed: number }> {
  if (!docs.length) return { ingested: 0, failed: 0 };
  const index = cfg.index ?? PROSPECTS_INDEX;
  const lines: string[] = [];
  for (const doc of docs) {
    lines.push(JSON.stringify({ index: { _index: index, _id: idOf(doc) } }));
    lines.push(JSON.stringify(doc));
  }
  const body = lines.join("\n") + "\n";
  const res = await osFetch<{ items?: { index?: { error?: unknown } }[] }>(cfg, "/_bulk", {
    method: "POST",
    headers: { "Content-Type": "application/x-ndjson" },
    body,
  });
  const items = res.items ?? [];
  const failed = items.filter((i) => i.index?.error).length;
  return { ingested: docs.length - failed, failed };
}

/**
 * Bulk create-only: documents that already exist are left untouched (HTTP 409 is expected, not
 * a failure). Used for vendor search results so a re-search never overwrites a prospect whose
 * email/phone was already revealed and stored.
 */
export async function bulkCreateProspects(
  cfg: OpenSearchConfig,
  docs: ProspectDocument[]
): Promise<{ created: number; existing: number; failed: number }> {
  if (!docs.length) return { created: 0, existing: 0, failed: 0 };
  const index = cfg.index ?? PROSPECTS_INDEX;
  const lines: string[] = [];
  for (const doc of docs) {
    lines.push(JSON.stringify({ create: { _index: index, _id: doc.prospectId } }));
    lines.push(JSON.stringify(doc));
  }
  // refresh=wait_for: the caller re-queries immediately, so new documents must be searchable.
  const res = await osFetch<{ items?: { create?: { status?: number; error?: unknown } }[] }>(cfg, "/_bulk?refresh=wait_for", {
    method: "POST",
    headers: { "Content-Type": "application/x-ndjson" },
    body: lines.join("\n") + "\n",
  });
  let created = 0;
  let existing = 0;
  let failed = 0;
  for (const item of res.items ?? []) {
    const c = item.create;
    if (!c?.error) created++;
    else if (c.status === 409) existing++;
    else failed++;
  }
  return { created, existing, failed };
}

export interface ProspectScorePatch {
  prospectId: string;
  icpScore: number;
  intentScore?: number;
  painPoints?: string[];
  outreachReadiness?: string;
}

/** Partial update of AI score fields on existing corpus documents. */
export async function bulkPatchProspectScores(
  cfg: OpenSearchConfig,
  patches: ProspectScorePatch[]
): Promise<{ updated: number; failed: number }> {
  if (!patches.length) return { updated: 0, failed: 0 };
  const index = cfg.index ?? PROSPECTS_INDEX;
  const now = new Date().toISOString();
  const lines: string[] = [];
  for (const patch of patches) {
    lines.push(JSON.stringify({ update: { _index: index, _id: patch.prospectId } }));
    lines.push(
      JSON.stringify({
        doc: {
          icpScore: patch.icpScore,
          ...(patch.intentScore != null ? { intentScore: patch.intentScore } : {}),
          ...(patch.painPoints?.length ? { painPoints: patch.painPoints } : {}),
          ...(patch.outreachReadiness ? { outreachReadiness: patch.outreachReadiness } : {}),
          updatedAt: now,
        },
      })
    );
  }
  const body = lines.join("\n") + "\n";
  const res = await osFetch<{ items?: { update?: { error?: unknown } }[] }>(cfg, "/_bulk", {
    method: "POST",
    headers: { "Content-Type": "application/x-ndjson" },
    body,
  });
  const items = res.items ?? [];
  const failed = items.filter((i) => i.update?.error).length;
  return { updated: patches.length - failed, failed };
}

export async function getProspectById(
  cfg: OpenSearchConfig,
  prospectId: string
): Promise<ProspectDocument | null> {
  const index = cfg.index ?? PROSPECTS_INDEX;
  try {
    const res = await osFetch<{ _source?: ProspectDocument }>(cfg, `/${index}/_doc/${prospectId}`);
    return res._source ?? null;
  } catch {
    return null;
  }
}

/** Seniority values the filter understands; anything else stored on a record counts as "not set". */
const KNOWN_SENIORITIES = ["founder", "co_founder", "ceo", "c_level", "vp", "director", "head", "manager", "individual_contributor"];

/** Title phrases that reliably mean a seniority. Matched as phrases on the analysed `title` field. */
const SENIORITY_TITLE_PHRASES: Record<string, string[]> = {
  founder: ["founder"],
  co_founder: ["co-founder", "cofounder", "co founder"],
  ceo: ["ceo", "chief executive"],
  c_level: ["chief", "cto", "cfo", "coo", "cmo", "cio", "cro", "cpo", "ciso", "cxo"],
  vp: ["vp", "vice president", "svp", "evp", "avp"],
  director: ["director"],
  head: ["head of", "head"],
  manager: ["manager"],
};

/**
 * Seniority filter. Most captured (real) prospects have no seniority stored, or a value outside
 * the filter's vocabulary, so a plain term filter silently excluded ~99% of them. A record now
 * matches when its stored seniority is one of the wanted values, OR when it has no valid
 * seniority and its job title contains a phrase that means one of them.
 */
export function seniorityClause(values: string[]): object {
  const phrases = [...new Set(values.flatMap((v) => SENIORITY_TITLE_PHRASES[v] ?? []))];
  const should: object[] = [{ terms: { seniority: values } }];
  if (phrases.length) {
    should.push({
      bool: {
        must_not: [{ terms: { seniority: KNOWN_SENIORITIES } }],
        should: phrases.map((phrase) => ({ match_phrase: { title: phrase } })),
        minimum_should_match: 1,
      },
    });
  }
  return { bool: { should, minimum_should_match: 1 } };
}

/** Build OpenSearch query from product filters + free-text query. */
export function buildSearchQuery(filters: SearchFilters, page = 1, pageSize = 25) {
  const must: object[] = [];
  const filter: object[] = [];

  if (filters.query?.trim()) {
    must.push({
      multi_match: {
        query: filters.query,
        fields: ["fullName^2", "title", "headline", "companyName", "companyDomain", "industry", "previousCompany", "skills", "schools", "location"],
        type: "best_fields",
      },
    });
  }
  if (Array.isArray(filters.dataSource)) filter.push({ terms: { dataSource: filters.dataSource } });
  else if (filters.dataSource) filter.push({ term: { dataSource: filters.dataSource } });

  // Contact information
  if (filters.fullName?.trim()) {
    filter.push({ match_phrase_prefix: { fullName: filters.fullName.trim() } });
  }
  if (filters.jobTitle?.trim()) {
    filter.push({ multi_match: { query: filters.jobTitle.trim(), fields: ["title", "headline"] } });
  }
  if (filters.department) filter.push({ term: { department: filters.department } });
  // seniority + seniorities are merged into one clause (see seniorityClause) below.
  if (filters.jobFunction) filter.push({ term: { jobFunction: filters.jobFunction } });
  if (filters.emailAvailable === true) filter.push({ exists: { field: "email" } });
  if (filters.phoneAvailable === true) filter.push({ exists: { field: "phone" } });
  if (filters.linkedInAvailable === true) filter.push({ exists: { field: "linkedinUrl" } });

  // Experience
  if (filters.minYearsAtCompany != null) {
    filter.push({ range: { yearsAtCompany: { gte: filters.minYearsAtCompany } } });
  }
  if (filters.minYearsInRole != null) {
    filter.push({ range: { yearsInRole: { gte: filters.minYearsInRole } } });
  }
  if (filters.minTotalYearsExperience != null) {
    filter.push({ range: { totalYearsExperience: { gte: filters.minTotalYearsExperience } } });
  }
  if (filters.previousCompany?.trim()) {
    filter.push({ match: { previousCompany: filters.previousCompany.trim() } });
  }

  // Activity signals — OR across selected types
  if (filters.contactSignals?.length) {
    filter.push({
      nested: {
        path: "signals",
        query: { terms: { "signals.type": filters.contactSignals } },
      },
    });
  }

  // Company — basic
  if (filters.companyName?.trim()) {
    filter.push({ match: { companyName: filters.companyName.trim() } });
  }
  if (filters.companyDomain?.trim()) {
    const domain = filters.companyDomain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    filter.push({ wildcard: { companyDomain: `*${domain}*` } });
  }
  if (filters.keyword?.trim()) {
    filter.push({
      multi_match: {
        query: filters.keyword.trim(),
        fields: ["industry", "subIndustry", "companyName"],
        type: "best_fields",
      },
    });
  }
  if (filters.industry)    filter.push({ term: { industry: filters.industry } });
  if (filters.subIndustry) filter.push({ term: { subIndustry: filters.subIndustry } });
  if (filters.country)     filter.push({ term: { country: filters.country } });
  if (filters.industries?.length)  filter.push({ terms: { industry: filters.industries } });
  if (filters.countries?.length)   filter.push({ terms: { country: filters.countries } });
  const wantedSeniorities = [...new Set([...(filters.seniority ? [filters.seniority] : []), ...(filters.seniorities ?? [])])];
  if (wantedSeniorities.length) filter.push(seniorityClause(wantedSeniorities));
  if (filters.employeeBuckets?.length) filter.push({ terms: { "employeeBucket.keyword": filters.employeeBuckets } });
  if (filters.state?.trim()) filter.push({ term: { state: filters.state.trim() } });
  if (filters.city?.trim())  filter.push({ match: { city: filters.city.trim() } });
  if (filters.minEmployees != null || filters.maxEmployees != null) {
    filter.push({
      range: {
        employeeCount: {
          ...(filters.minEmployees != null ? { gte: filters.minEmployees } : {}),
          ...(filters.maxEmployees != null ? { lte: filters.maxEmployees } : {}),
        },
      },
    });
  }

  // Company — stage & funding
  if (filters.companyStage)     filter.push({ term: { companyStage: filters.companyStage } });
  if (filters.lastFundingRound) filter.push({ term: { lastFundingRound: filters.lastFundingRound } });
  if (filters.minRevenue != null || filters.maxRevenue != null) {
    filter.push({
      range: {
        annualRevenue: {
          ...(filters.minRevenue != null ? { gte: filters.minRevenue } : {}),
          ...(filters.maxRevenue != null ? { lte: filters.maxRevenue } : {}),
        },
      },
    });
  }
  if (filters.minFoundedYear != null || filters.maxFoundedYear != null) {
    filter.push({
      range: {
        foundedYear: {
          ...(filters.minFoundedYear != null ? { gte: filters.minFoundedYear } : {}),
          ...(filters.maxFoundedYear != null ? { lte: filters.maxFoundedYear } : {}),
        },
      },
    });
  }
  if (filters.minHeadcountGrowth != null) {
    filter.push({ range: { headcountGrowth: { gte: filters.minHeadcountGrowth } } });
  }
  if (filters.companyEmailProvider) {
    filter.push({ term: { companyEmailProvider: filters.companyEmailProvider } });
  }
  if (filters.minIntentScore != null) {
    filter.push({ range: { intentScore: { gte: filters.minIntentScore } } });
  }

  // Hiring
  if (filters.currentlyHiring === true) filter.push({ term: { currentlyHiring: true } });
  if (filters.hiringDepartments?.length) {
    filter.push({
      terms: { hiringDepartments: filters.hiringDepartments },
    });
  }

  // Company signals (OR logic)
  if (filters.companySignals?.length) {
    filter.push({
      nested: {
        path: "signals",
        query: { terms: { "signals.type": filters.companySignals } },
      },
    });
  }

  // Tech / intent signals (existing)
  if (filters.tech) {
    filter.push({
      nested: {
        path: "techStack",
        query: { match: { "techStack.technology": filters.tech } },
      },
    });
  }
  if (filters.signal) {
    filter.push({
      nested: {
        path: "signals",
        query: { term: { "signals.type": filters.signal } },
      },
    });
  }

  return {
    from: (page - 1) * pageSize,
    size: pageSize,
    query: {
      bool: (() => {
        const bool: Record<string, unknown> = {};
        if (must.length) bool.must = must;
        if (filter.length) bool.filter = filter;
        if (!must.length && !filter.length) bool.must = [{ match_all: {} }];
        return bool;
      })(),
    },
    sort: filters.stableOrder
      ? [{ updatedAt: "asc" }, { prospectId: "asc" }]
      : [{ updatedAt: "desc" }],
  };
}

export interface SegmentBucket {
  dimension: "industry" | "size" | "geo";
  value: string;
  count: number;
}

export interface AggregateResult {
  total: number;
  segments: SegmentBucket[];
}

/**
 * R12.1 — total count + industry/size/geo breakdown for a filter set, without paginating
 * through hits. `size: 0` — this is a pure aggregation query, no documents returned.
 */
export async function aggregateProspects(cfg: OpenSearchConfig, filters: SearchFilters): Promise<AggregateResult> {
  const index = cfg.index ?? PROSPECTS_INDEX;
  const { query } = buildSearchQuery(filters, 1, 0);
  const MAX_BUCKETS = 25;

  const body = {
    size: 0,
    query,
    aggs: {
      industry: { terms: { field: "industry", size: MAX_BUCKETS, missing: "unknown" } },
      // Bonsai dynamic mapping stored employeeBucket as text + `.keyword`; aggregating
      // on the text field 400s. `.keyword` works there and on indexes we create.
      size: { terms: { field: "employeeBucket.keyword", size: MAX_BUCKETS, missing: "unknown" } },
      geo: { terms: { field: "country", size: MAX_BUCKETS, missing: "unknown" } },
    },
  };

  const res = await osFetch<{
    hits: { total: { value: number } };
    aggregations: Record<"industry" | "size" | "geo", { buckets: { key: string; doc_count: number }[] }>;
  }>(cfg, `/${index}/_search`, { method: "POST", body: JSON.stringify(body) });

  const segments: SegmentBucket[] = [];
  for (const dimension of ["industry", "size", "geo"] as const) {
    for (const bucket of res.aggregations[dimension]?.buckets ?? []) {
      segments.push({ dimension, value: bucket.key, count: bucket.doc_count });
    }
  }

  return { total: res.hits.total.value, segments };
}

function needsSearchPostProcess(filters: SearchFilters): boolean {
  return Boolean(
    filters.excludeDuplicates ||
      (filters.maxPerCompany != null && filters.maxPerCompany > 0)
  );
}

async function searchProspectsWithPostProcess(
  cfg: OpenSearchConfig,
  filters: SearchFilters,
  page: number,
  pageSize: number
): Promise<SearchResult> {
  const index = cfg.index ?? PROSPECTS_INDEX;
  const batchSize = Math.min(Math.max(pageSize * 4, pageSize), 200);
  const targetStart = (page - 1) * pageSize;
  const targetEnd = targetStart + pageSize;
  const maxScan = 20_000;

  let processed: ProspectDocument[] = [];
  let osFrom = 0;
  let rawTotal = 0;
  let exhausted = false;

  while (processed.length < targetEnd && osFrom < maxScan) {
    const body = buildSearchQuery(filters, 1, batchSize);
    body.from = osFrom;
    body.size = batchSize;

    const res = await osFetch<{
      hits: { total: { value: number }; hits: { _source: ProspectDocument }[] };
    }>(cfg, `/${index}/_search`, { method: "POST", body: JSON.stringify(body) });

    rawTotal = res.hits.total.value;
    const batch = res.hits.hits.map((h) => h._source);
    if (!batch.length) {
      exhausted = true;
      break;
    }

    processed = postProcessSearchHits([...processed, ...batch], filters);
    osFrom += batch.length;

    if (batch.length < batchSize || osFrom >= rawTotal) {
      exhausted = true;
      break;
    }
  }

  let total = processed.length;
  if (!exhausted && osFrom < rawTotal) {
    while (osFrom < rawTotal && osFrom < maxScan) {
      const body = buildSearchQuery(filters, 1, batchSize);
      body.from = osFrom;
      body.size = batchSize;
      const res = await osFetch<{
        hits: { total: { value: number }; hits: { _source: ProspectDocument }[] };
      }>(cfg, `/${index}/_search`, { method: "POST", body: JSON.stringify(body) });
      const batch = res.hits.hits.map((h) => h._source);
      if (!batch.length) break;
      processed = postProcessSearchHits([...processed, ...batch], filters);
      osFrom += batch.length;
      if (batch.length < batchSize) break;
    }
    total = processed.length;
    if (osFrom < rawTotal) total = Math.max(total, rawTotal);
  }

  return {
    hits: processed.slice(targetStart, targetEnd),
    total,
  };
}

export async function searchProspects(
  cfg: OpenSearchConfig,
  filters: SearchFilters,
  page = 1,
  pageSize = 25
): Promise<SearchResult> {
  if (needsSearchPostProcess(filters)) {
    return searchProspectsWithPostProcess(cfg, filters, page, pageSize);
  }

  const index = cfg.index ?? PROSPECTS_INDEX;
  const body = buildSearchQuery(filters, page, pageSize);
  const res = await osFetch<{
    hits: { total: { value: number }; hits: { _source: ProspectDocument }[] };
  }>(cfg, `/${index}/_search`, { method: "POST", body: JSON.stringify(body) });

  return {
    hits: res.hits.hits.map((h) => h._source),
    total: res.hits.total.value,
  };
}

/** The query part of buildSearchQuery (no paging/sort), for counts and id checks. */
function filterQuery(filters: SearchFilters): object {
  return buildSearchQuery(filters, 1, 0).query;
}

/** Exact number of prospects matching the filters (live count while a list is being edited). */
export async function countProspects(cfg: OpenSearchConfig, filters: SearchFilters): Promise<number> {
  const index = cfg.index ?? PROSPECTS_INDEX;
  const res = await osFetch<{ count: number }>(cfg, `/${index}/_count`, {
    method: "POST",
    body: JSON.stringify({ query: filterQuery(filters) }),
  });
  return res.count;
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface ProspectFacets {
  total: number;
  industry: FacetValue[];
  country: FacetValue[];
  seniority: FacetValue[];
}

/**
 * The values actually stored in the index, with counts. Filters are exact matches, so choices
 * offered to users (and values typed by them) must come from here, not from hard-coded lists
 * that drift from the data.
 */
export async function fetchProspectFacets(cfg: OpenSearchConfig, size = 200): Promise<ProspectFacets> {
  const index = cfg.index ?? PROSPECTS_INDEX;
  const res = await osFetch<{
    hits: { total: { value: number } };
    aggregations: Record<"industry" | "country" | "seniority", { buckets: { key: string; doc_count: number }[] }>;
  }>(cfg, `/${index}/_search`, {
    method: "POST",
    body: JSON.stringify({
      size: 0,
      track_total_hits: true,
      aggs: {
        industry: { terms: { field: "industry", size } },
        country: { terms: { field: "country", size } },
        seniority: { terms: { field: "seniority", size: 50 } },
      },
    }),
  });
  const values = (k: "industry" | "country" | "seniority") =>
    (res.aggregations?.[k]?.buckets ?? []).map((b) => ({ value: String(b.key), count: b.doc_count }));
  return { total: res.hits.total.value, industry: values("industry"), country: values("country"), seniority: values("seniority") };
}

/** Execute a saved smart-list filter set (stored as SearchFilters JSON). */
export async function runSmartListQuery(
  cfg: OpenSearchConfig,
  filters: SearchFilters,
  limit = 1000
): Promise<{ hits: ProspectDocument[]; total: number }> {
  if (needsSearchPostProcess(filters)) {
    const res = await searchProspects(cfg, filters, 1, limit);
    return { hits: res.hits, total: res.total };
  }
  const index = cfg.index ?? PROSPECTS_INDEX;
  // track_total_hits: without it OpenSearch stops counting at 10,000, and the list's count would
  // be capped at the number of hits kept (limit) rather than the real number of matches.
  const body = { ...buildSearchQuery(filters, 1, limit), track_total_hits: true };
  const res = await osFetch<{
    hits: { total: { value: number }; hits: { _source: ProspectDocument }[] };
  }>(cfg, `/${index}/_search`, { method: "POST", body: JSON.stringify(body) });
  return { hits: res.hits.hits.map((h) => h._source), total: res.hits.total.value };
}

/**
 * Which of `prospectIds` still match the filters. A refresh keeps at most `limit` hits, so a
 * member missing from the kept hits may simply have been pushed past the cap; this tells the
 * two cases apart so such members are not reported as dropped.
 */
export async function prospectIdsStillMatching(
  cfg: OpenSearchConfig,
  filters: SearchFilters,
  prospectIds: string[]
): Promise<Set<string>> {
  if (prospectIds.length === 0) return new Set();
  const index = cfg.index ?? PROSPECTS_INDEX;
  const base = buildSearchQuery(filters, 1, 0).query as { bool: { must?: object[]; filter?: object[] } };
  // Indexes we create map prospectId as keyword; ones created by dynamic mapping (Bonsai) store
  // text + .keyword. Match either; a sub-field that doesn't exist simply matches nothing.
  const idClause = {
    bool: {
      should: [{ terms: { prospectId: prospectIds } }, { terms: { "prospectId.keyword": prospectIds } }],
      minimum_should_match: 1,
    },
  };
  const query = { bool: { ...base.bool, filter: [...(base.bool.filter ?? []), idClause] } };
  const res = await osFetch<{ hits: { hits: { _source: { prospectId: string } }[] } }>(cfg, `/${index}/_search`, {
    method: "POST",
    body: JSON.stringify({ size: prospectIds.length, _source: ["prospectId"], query }),
  });
  return new Set(res.hits.hits.map((h) => h._source.prospectId));
}

/** The documents for these ids. An id with no document is simply absent from the answer. */
export async function getProspectsByIds(cfg: OpenSearchConfig, prospectIds: string[]): Promise<ProspectDocument[]> {
  if (prospectIds.length === 0) return [];
  const index = cfg.index ?? PROSPECTS_INDEX;
  // Either mapping of prospectId (see prospectIdsStillMatching).
  const query = {
    bool: {
      should: [{ terms: { prospectId: prospectIds } }, { terms: { "prospectId.keyword": prospectIds } }],
      minimum_should_match: 1,
    },
  };
  const res = await osFetch<{ hits: { hits: { _source: ProspectDocument }[] } }>(cfg, `/${index}/_search`, {
    method: "POST",
    body: JSON.stringify({ size: prospectIds.length, query }),
  });
  return res.hits.hits.map((h) => h._source);
}

const idSortFields = new Map<string, string>();

/**
 * The field that orders documents by prospect id. Indexes we create map `prospectId` as keyword; ones created by
 * dynamic mapping (Bonsai) store text, which cannot be sorted on, with a `.keyword` beside it.
 */
async function idSortField(cfg: OpenSearchConfig): Promise<string> {
  const index = cfg.index ?? PROSPECTS_INDEX;
  const key = `${cfg.url}/${index}`;
  const known = idSortFields.get(key);
  if (known) return known;
  type Mapping = { mappings?: { properties?: { prospectId?: { type?: string; fields?: { keyword?: unknown } } } } };
  const res = await osFetch<Record<string, Mapping>>(cfg, `/${index}/_mapping`);
  const mapped = Object.values(res)[0]?.mappings?.properties?.prospectId;
  const field = mapped?.type === "text" && mapped.fields?.keyword ? "prospectId.keyword" : "prospectId";
  if (mapped) idSortFields.set(key, field);
  return field;
}

/**
 * Walks every match of a filter set, a page at a time, ordered by prospect id. `search_after` has no 10,000-result
 * window, unlike `from`. Pass the previous answer's `next` until it is null.
 */
export async function matchingProspectsAfter(
  cfg: OpenSearchConfig,
  filters: SearchFilters,
  size: number,
  after: unknown[] | null = null
): Promise<{ hits: ProspectDocument[]; next: unknown[] | null }> {
  const index = cfg.index ?? PROSPECTS_INDEX;
  const { query } = buildSearchQuery(filters, 1, size);
  const res = await osFetch<{ hits: { hits: { _source: ProspectDocument; sort?: unknown[] }[] } }>(cfg, `/${index}/_search`, {
    method: "POST",
    body: JSON.stringify({ query, size, sort: [{ [await idSortField(cfg)]: "asc" }], ...(after ? { search_after: after } : {}) }),
  });
  const found = res.hits.hits;
  const last = found.length === size ? (found[found.length - 1]!.sort ?? null) : null;
  return { hits: found.map((h) => h._source), next: last };
}

/** One numbered page of a filter set's matches, ordered by prospect id so pages do not overlap, with the exact total. */
export async function matchingProspectsPage(
  cfg: OpenSearchConfig,
  filters: SearchFilters,
  page: number,
  pageSize: number
): Promise<SearchResult> {
  const index = cfg.index ?? PROSPECTS_INDEX;
  const { query, from, size } = buildSearchQuery(filters, page, pageSize);
  const res = await osFetch<{ hits: { total: { value: number }; hits: { _source: ProspectDocument }[] } }>(cfg, `/${index}/_search`, {
    method: "POST",
    body: JSON.stringify({ query, from, size, sort: [{ [await idSortField(cfg)]: "asc" }], track_total_hits: true }),
  });
  return { hits: res.hits.hits.map((h) => h._source), total: res.hits.total.value };
}

/**
 * Query OpenSearch when it is configured. The in-process demo corpus is only used when no
 * OpenSearch is configured at all (local dev). A configured cluster that fails must surface as an
 * error: silently answering with fake prospects led refreshes, scoring and activation to act on
 * demo people.
 */
export async function runSmartListQueryWithFallback(
  cfg: OpenSearchConfig | null,
  filters: SearchFilters,
  limit = 1000
): Promise<{ hits: ProspectDocument[]; total: number; demo: boolean }> {
  if (cfg) {
    const { hits, total } = await runSmartListQuery(cfg, filters, limit);
    return { hits, total, demo: false };
  }
  const hits = filterDemoCorpus(buildDemoCorpus(), filters, limit);
  return { hits, total: hits.length, demo: true };
}
