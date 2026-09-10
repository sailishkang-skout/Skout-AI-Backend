import type { RawScrapeRecord } from "@skout/scraper-contracts";

const BASE = process.env.OPENCORPORATES_BASE_URL ?? "https://api.opencorporates.com/v0.4";

/** OpenCorporates company search (strategy §7.1 / E1.3). Requires OPENCORPORATES_API_KEY. */
export async function scrapeOpenCorporates(jobId: string, query: string): Promise<RawScrapeRecord[]> {
  const apiKey = process.env.OPENCORPORATES_API_KEY;
  if (!apiKey) {
    return [
      {
        jobId,
        source: "opencorporates",
        scrapedAt: new Date().toISOString(),
        payload: { error: "OPENCORPORATES_API_KEY not configured", query },
        meta: { skipped: true },
      },
    ];
  }

  const url = `${BASE}/companies/search?q=${encodeURIComponent(query)}&api_token=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = (await res.json()) as {
    results?: { company?: Record<string, unknown> }[];
  };

  return (body.results ?? []).slice(0, 10).map((r) => ({
    jobId,
    source: "opencorporates" as const,
    scrapedAt: new Date().toISOString(),
    url,
    payload: r.company ?? r,
    meta: { provider: "opencorporates" },
  }));
}
