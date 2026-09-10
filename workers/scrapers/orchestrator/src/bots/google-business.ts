import type { RawScrapeRecord } from "@skout/scraper-contracts";
import { fetchPageSmart } from "../proxy-fetch.js";

function normalizeQuery(seed: string): string {
  return seed.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** Lightweight Google Business / Maps public page scrape (company name + category). */
export async function scrapeGoogleBusiness(jobId: string, seed: string): Promise<RawScrapeRecord[]> {
  const query = encodeURIComponent(normalizeQuery(seed));
  const url = `https://www.google.com/maps/search/${query}`;
  const page = await fetchPageSmart(url, undefined, "google-business");
  if (!page?.html) {
    return [
      {
        jobId,
        source: "google-business",
        scrapedAt: new Date().toISOString(),
        url,
        payload: { query: seed, error: "fetch_failed" },
      },
    ];
  }

  const nameMatch = page.html.match(/"title":"([^"]{2,120})"/);
  const categoryMatch = page.html.match(/"category":"([^"]+)"/);
  const addressMatch = page.html.match(/"address":"([^"]+)"/);

  return [
    {
      jobId,
      source: "google-business",
      scrapedAt: new Date().toISOString(),
      url,
      payload: {
        query: seed,
        companyName: nameMatch?.[1],
        industry: categoryMatch?.[1],
        location: addressMatch?.[1],
        provenance: { source: "google-business", fetchedAt: new Date().toISOString() },
      },
    },
  ];
}
