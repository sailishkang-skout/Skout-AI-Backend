import type { RawScrapeRecord } from "@skout/scraper-contracts";
import { scrapeCrunchbase } from "./crunchbase.js";
import { scrapeLinkedInJobs } from "./linkedin-jobs.js";

/** Combined hiring + funding signal collector (R6.5). */
export async function scrapeHiringFundingSignals(
  jobId: string,
  seed: string
): Promise<RawScrapeRecord[]> {
  const [funding, hiring] = await Promise.all([
    scrapeCrunchbase(jobId, seed),
    scrapeLinkedInJobs(jobId, seed),
  ]);
  return [...funding, ...hiring];
}
