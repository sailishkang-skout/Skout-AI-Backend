import type { RawScrapeRecord } from "@skout/scraper-contracts";

const BASE = process.env.SEC_EDGAR_BASE_URL ?? "https://efts.sec.gov/LATEST/search-index";

/** SEC EDGAR full-text search — free public financials (strategy §7.1 / E1.3). */
export async function scrapeSecEdgar(jobId: string, query: string): Promise<RawScrapeRecord[]> {
  const url = `${BASE}?q=${encodeURIComponent(query)}&dateRange=custom&startdt=2020-01-01&forms=10-K,10-Q,8-K`;
  const res = await fetch(url, {
    headers: { "User-Agent": process.env.SEC_EDGAR_USER_AGENT ?? "Skout AI contact@skout.ai" },
    signal: AbortSignal.timeout(15000),
  });
  const body = (await res.json()) as { hits?: { hits?: { _source?: Record<string, unknown> }[] } };
  const hits = body.hits?.hits ?? [];

  return hits.slice(0, 10).map((h) => ({
    jobId,
    source: "sec-edgar" as const,
    scrapedAt: new Date().toISOString(),
    url,
    payload: h._source ?? {},
    meta: { provider: "sec-edgar" },
  }));
}
