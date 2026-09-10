import type { RawScrapeRecord } from "@skout/scraper-contracts";

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * LinkedIn company/people scrape (strategy §7.1 / E3).
 * Without authenticated sessions, fetches public company pages when possible.
 */
export async function scrapeLinkedIn(jobId: string, seed: string): Promise<RawScrapeRecord[]> {
  const accountsJson = process.env.LINKEDIN_ACCOUNTS_JSON;
  const hasAccounts = Boolean(accountsJson && accountsJson !== "[]");

  const companyUrl = seed.startsWith("http")
    ? seed
    : seed.includes("/")
      ? `https://www.linkedin.com/${seed.replace(/^\//, "")}`
      : `https://www.linkedin.com/company/${seed}`;

  if (!hasAccounts) {
    try {
      const res = await fetch(companyUrl, {
        headers: {
          "User-Agent": process.env.SCRAPER_USER_AGENT ?? "SkoutBot/1.0 (+https://skout.ai)",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(Number(process.env.SCRAPER_REQUEST_TIMEOUT_MS ?? 15000)),
      });
      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch?.[1]?.replace(/\s*\|\s*LinkedIn.*$/i, "").trim();
      const employeeMatch = html.match(/(\d[\d,]*)\s+employees/i);
      const employeeCount = employeeMatch ? Number(employeeMatch[1].replace(/,/g, "")) : undefined;
      const industryMatch = html.match(/Industry[^<]*<[^>]*>([^<]+)/i);

      return [
        {
          jobId,
          source: "linkedin",
          scrapedAt: new Date().toISOString(),
          url: companyUrl,
          payload: {
            seed,
            companyName: title,
            industry: industryMatch?.[1]?.trim(),
            employeeCount,
            html: html.slice(0, 200_000),
            mode: "public_page",
          },
          meta: { statusCode: res.status, authenticated: false },
        },
      ];
    } catch {
      return [
        {
          jobId,
          source: "linkedin",
          scrapedAt: new Date().toISOString(),
          payload: {
            seed,
            note: "LinkedIn bot requires LINKEDIN_ACCOUNTS_JSON for full profile scrape",
          },
          meta: { skipped: true, reason: "no_credentials" },
        },
      ];
    }
  }

  return [
    {
      jobId,
      source: "linkedin",
      scrapedAt: new Date().toISOString(),
      url: companyUrl,
      payload: {
        seed,
        companyName: stripHtml(companyUrl.split("/").pop() ?? seed),
        mode: "authenticated_pending",
        note: "Provision Playwright session for full LinkedIn people scrape",
      },
      meta: { provider: "linkedin", authenticated: true },
    },
  ];
}
