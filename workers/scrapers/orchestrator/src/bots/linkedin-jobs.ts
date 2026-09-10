import type { RawScrapeRecord } from "@skout/scraper-contracts";
import { fetchPageSmart } from "../proxy-fetch.js";
import { countJobListings, extractHiringByDept, HIRING_KEYWORDS } from "./company-web-extract.js";

function normalizeDomain(seed: string): string {
  return seed.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? seed;
}

/** Careers / jobs board collector (E5.1) — focused hiring signals per domain. */
export async function scrapeLinkedInJobs(jobId: string, seed: string): Promise<RawScrapeRecord[]> {
  const domain = normalizeDomain(seed);
  const careersUrl = `https://${domain}/careers`;
  const jobsUrl = `https://${domain}/jobs`;

  let html = "";
  for (const url of [careersUrl, jobsUrl, `https://boards.greenhouse.io/${domain.split(".")[0]}`]) {
    const page = await fetchPageSmart(url);
    if (page) {
      html += page.html;
      if (HIRING_KEYWORDS.test(page.html) || countJobListings(page.html) > 0) break;
    }
  }

  const openJobs = countJobListings(html);
  const hiringByDept = extractHiringByDept(html);

  return [
    {
      jobId,
      source: "linkedin-jobs",
      scrapedAt: new Date().toISOString(),
      url: careersUrl,
      payload: {
        domain,
        isHiring: openJobs > 0 || HIRING_KEYWORDS.test(html),
        openJobs: openJobs || undefined,
        hiringByDept: Object.keys(hiringByDept).length ? hiringByDept : undefined,
        html: html.slice(0, 200_000),
      },
      meta: { collector: "job-board" },
    },
  ];
}
