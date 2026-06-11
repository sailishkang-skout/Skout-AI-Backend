/** Default OpenSearch index for the global prospect corpus. */
export const PROSPECTS_INDEX = process.env.OPENSEARCH_INDEX ?? "prospects";

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
  email?: string;
  companyDomain: string;
  companyName?: string;
  industry?: string;
  subIndustry?: string;
  country?: string;
  employeeCount?: number;
  employeeBucket?: string;
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
  industry?: string;
  country?: string;
  seniority?: string;
  minEmployees?: number;
  maxEmployees?: number;
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
          companyDomain: { type: "keyword" },
          companyName: { type: "text" },
          industry: { type: "keyword" },
          country: { type: "keyword" },
          employeeCount: { type: "integer" },
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
  if (filters.industry) filter.push({ term: { industry: filters.industry } });
  if (filters.country) filter.push({ term: { country: filters.country } });
  if (filters.seniority) filter.push({ term: { seniority: filters.seniority } });
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
    hits: res.hits.hits.map((h) => h._source),
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
