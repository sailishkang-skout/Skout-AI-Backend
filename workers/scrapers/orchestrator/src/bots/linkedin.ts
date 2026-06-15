import type { RawScrapeRecord } from "@skout/scraper-contracts";

/**
 * LinkedIn company/people scrape (strategy §7.1 / E3).
 * Production requires authenticated sessions from Secrets Manager `{Prefix}/scraper/linkedin`.
 * This handler validates config and returns structured stubs when credentials are absent.
 */
export async function scrapeLinkedIn(jobId: string, seed: string): Promise<RawScrapeRecord[]> {
  const accountsJson = process.env.LINKEDIN_ACCOUNTS_JSON;
  if (!accountsJson || accountsJson === "[]") {
    return [
      {
        jobId,
        source: "linkedin",
        scrapedAt: new Date().toISOString(),
        payload: {
          seed,
          note: "LinkedIn bot requires LINKEDIN_ACCOUNTS_JSON from Secrets Manager",
        },
        meta: { skipped: true, reason: "no_credentials" },
      },
    ];
  }

  // Placeholder for authenticated Playwright/httpx session — extend when accounts are provisioned.
  return [
    {
      jobId,
      source: "linkedin",
      scrapedAt: new Date().toISOString(),
      url: seed.startsWith("http") ? seed : `https://www.linkedin.com/company/${seed}`,
      payload: { seed, status: "credentials_present_pending_implementation" },
      meta: { provider: "linkedin", authenticated: true },
    },
  ];
}
