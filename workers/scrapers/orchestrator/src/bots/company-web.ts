import type { RawScrapeRecord } from "@skout/scraper-contracts";
import { fetchPageSmart } from "../proxy-fetch.js";
import {
  CAREERS_PATHS,
  countJobListings,
  extractFirmographics,
  extractHiringByDept,
  HIRING_KEYWORDS,
} from "./company-web-extract.js";

function normalizeDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? domain;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Crawl homepage + common paths; extract firmographics + hiring signals. */
export async function scrapeCompanyWeb(jobId: string, domain: string): Promise<RawScrapeRecord> {
  const host = normalizeDomain(domain);
  const base = `https://${host}`;
  const pageDelay = Number(process.env.SCRAPER_PAGE_DELAY_MS ?? 400);
  const htmlParts: string[] = [];
  let isHiring = false;
  let openJobs = 0;
  let hiringByDept: Record<string, number> | undefined;
  const pagesVisited: string[] = [];
  let firmographics = extractFirmographics("", host);

  const homepage = await fetchPageSmart(base);
  if (homepage) {
    htmlParts.push(homepage.html);
    pagesVisited.push(base);
    firmographics = extractFirmographics(homepage.html, host);
    if (HIRING_KEYWORDS.test(homepage.html)) {
      isHiring = true;
      openJobs = Math.max(openJobs, countJobListings(homepage.html));
    }
  }

  for (const path of CAREERS_PATHS) {
    await sleep(pageDelay);
    const page = await fetchPageSmart(`${base}${path}`);
    if (!page) continue;
    pagesVisited.push(`${base}${path}`);
    htmlParts.push(page.html);
    const pageHints = extractFirmographics(page.html, host);
    firmographics = { ...firmographics, ...pageHints };
    const deptCounts = extractHiringByDept(page.html);
    if (Object.keys(deptCounts).length) {
      hiringByDept = { ...(hiringByDept ?? {}), ...deptCounts };
    }
    if (
      HIRING_KEYWORDS.test(page.html) ||
      path.includes("career") ||
      path.includes("job")
    ) {
      isHiring = true;
      openJobs = Math.max(openJobs, countJobListings(page.html), 1);
    }
  }

  const combinedHtml = htmlParts.join("\n");

  return {
    jobId,
    source: "company-web",
    scrapedAt: new Date().toISOString(),
    url: base,
    payload: {
      domain: host,
      companyName: firmographics.companyName,
      description: firmographics.description,
      industry: firmographics.industry,
      keywords: firmographics.keywords,
      employeeCount: firmographics.employeeCount,
      foundedYear: firmographics.foundedYear,
      hqCity: firmographics.hqCity,
      hqState: firmographics.hqState,
      hqCountry: firmographics.hqCountry,
      companyStage: firmographics.companyStage,
      html: combinedHtml.slice(0, 500_000),
      htmlLength: combinedHtml.length,
      isHiring,
      openJobs: openJobs || undefined,
      hiringByDept,
      pagesVisited,
    },
    meta: { statusCode: homepage?.status ?? 0, pages: pagesVisited.length },
  };
}
