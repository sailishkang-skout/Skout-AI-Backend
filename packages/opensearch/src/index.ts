import { buildDemoCorpus, filterDemoCorpus, postProcessSearchHits } from "./demo-corpus.js";

/** Default OpenSearch index for the global prospect corpus. */
export const PROSPECTS_INDEX = process.env.OPENSEARCH_INDEX ?? "prospects";

export { buildDemoCorpus, filterDemoCorpus, postProcessSearchHits } from "./demo-corpus.js";

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
  updatedAt: string;
}

export interface SearchFilters {
  query?: string;
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
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeader(cfg),
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15000),
  });
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
          updatedAt: { type: "date" },
        },
      },
    }),
  });
}

/** Bulk upsert documents (idempotent by prospectId). */
export async function bulkUpsertProspects(
  cfg: OpenSearchConfig,
  docs: ProspectDocument[]
): Promise<{ ingested: number; failed: number }> {
  if (!docs.length) return { ingested: 0, failed: 0 };
  const index = cfg.index ?? PROSPECTS_INDEX;
  const lines: string[] = [];
  for (const doc of docs) {
    lines.push(JSON.stringify({ index: { _index: index, _id: doc.prospectId } }));
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

/** Build OpenSearch query from product filters + free-text query. */
export function buildSearchQuery(filters: SearchFilters, page = 1, pageSize = 25) {
  const must: object[] = [];
  const filter: object[] = [];

  if (filters.query?.trim()) {
    must.push({
      multi_match: {
        query: filters.query,
        fields: ["fullName^2", "title", "companyName", "companyDomain", "industry"],
        type: "best_fields",
      },
    });
  }
  // Contact information
  if (filters.fullName?.trim()) {
    filter.push({ match_phrase_prefix: { fullName: filters.fullName.trim() } });
  }
  if (filters.jobTitle?.trim()) {
    filter.push({ match: { title: filters.jobTitle.trim() } });
  }
  if (filters.department) filter.push({ term: { department: filters.department } });
  if (filters.seniority) filter.push({ term: { seniority: filters.seniority } });
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
      nested: {
        path: "signals",
        query: {
          bool: {
            must: [
              { term: { "signals.type": "hiring" } },
              { terms: { "signals.department": filters.hiringDepartments } },
            ],
          },
        },
      },
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
    sort: [{ updatedAt: "desc" }],
  };
}

export async function searchProspects(
  cfg: OpenSearchConfig,
  filters: SearchFilters,
  page = 1,
  pageSize = 25
): Promise<SearchResult> {
  const index = cfg.index ?? PROSPECTS_INDEX;
  const body = buildSearchQuery(filters, page, pageSize);
  const res = await osFetch<{
    hits: { total: { value: number }; hits: { _source: ProspectDocument }[] };
  }>(cfg, `/${index}/_search`, { method: "POST", body: JSON.stringify(body) });

  return {
    hits: postProcessSearchHits(
      res.hits.hits.map((h) => h._source),
      filters
    ),
    total: res.hits.total.value,
  };
}

/** Execute a saved smart-list filter set (stored as SearchFilters JSON). */
export async function runSmartListQuery(
  cfg: OpenSearchConfig,
  filters: SearchFilters,
  limit = 1000
): Promise<ProspectDocument[]> {
  const res = await searchProspects(cfg, filters, 1, limit);
  return res.hits;
}

/**
 * Query OpenSearch when configured; otherwise (or on connection failure) use the
 * in-process demo corpus so smart lists work in local dev without Docker OpenSearch.
 */
export async function runSmartListQueryWithFallback(
  cfg: OpenSearchConfig | null,
  filters: SearchFilters,
  limit = 1000
): Promise<{ hits: ProspectDocument[]; demo: boolean }> {
  if (cfg) {
    try {
      const hits = await runSmartListQuery(cfg, filters, limit);
      return { hits, demo: false };
    } catch {
      // fall through to demo corpus
    }
  }
  return { hits: filterDemoCorpus(buildDemoCorpus(), filters, limit), demo: true };
}
