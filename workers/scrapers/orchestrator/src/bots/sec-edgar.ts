import type { RawScrapeRecord } from "@skout/scraper-contracts";
import { fetchSecCompanyFacts } from "./sec-edgar-facts.js";

const BASE = process.env.SEC_EDGAR_BASE_URL ?? "https://efts.sec.gov/LATEST/search-index";

/** SEC EDGAR full-text search + optional companyfacts revenue (E1.3 / E5.2). */
export async function scrapeSecEdgar(jobId: string, query: string): Promise<RawScrapeRecord[]> {
  const records: RawScrapeRecord[] = [];

  if (/^[A-Z]{1,5}$/.test(query.trim())) {
    const facts = await fetchSecCompanyFacts(query.trim());
    if (facts) {
      records.push({
        jobId,
        source: "sec-edgar",
        scrapedAt: new Date().toISOString(),
        url: `https://data.sec.gov/companyfacts/${query}`,
        payload: { ...facts, domain: `${query.toLowerCase()}.com`, seed: query },
        meta: { provider: "sec-companyfacts" },
      });
    }
  }

  const url = `${BASE}?q=${encodeURIComponent(query)}&dateRange=custom&startdt=2020-01-01&forms=10-K,10-Q,8-K`;
  const res = await fetch(url, {
    headers: { "User-Agent": process.env.SEC_EDGAR_USER_AGENT ?? "Skout AI contact@skout.ai" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { hits?: { hits?: { _source?: Record<string, unknown> }[] } };
  const hits = body.hits?.hits ?? [];

  for (const h of hits.slice(0, 10)) {
    records.push({
      jobId,
      source: "sec-edgar",
      scrapedAt: new Date().toISOString(),
      url,
      payload: { ...(h._source ?? {}), seed: query },
      meta: { provider: "sec-edgar" },
    });
  }

  return records;
}
