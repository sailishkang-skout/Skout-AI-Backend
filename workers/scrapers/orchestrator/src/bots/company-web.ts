import type { RawScrapeRecord } from "@skout/scraper-contracts";

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function metaContent(html: string, name: string): string | undefined {
  const re = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)`, "i");
  const m = html.match(re);
  return m?.[1];
}

function normalizeDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? domain;
}

const CAREERS_PATHS = ["/careers", "/jobs", "/join-us", "/work-with-us", "/about", "/about-us", "/team"];
const HIRING_KEYWORDS =
  /\b(careers?|we(?:'re| are) hiring|open roles?|job openings?|join our team|view positions)\b/i;

async function fetchPage(url: string): Promise<{ html: string; status: number } | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": process.env.SCRAPER_USER_AGENT ?? "SkoutBot/1.0 (+https://skout.ai)" },
      signal: AbortSignal.timeout(Number(process.env.SCRAPER_REQUEST_TIMEOUT_MS ?? 15000)),
      redirect: "follow",
    });
    if (!res.ok) return null;
    return { html: await res.text(), status: res.status };
  } catch {
    return null;
  }
}

function countJobListings(html: string): number {
  const lower = html.toLowerCase();
  const matches = lower.match(/class=["'][^"']*job[^"']*["']/g);
  return matches?.length ?? 0;
}

/** Crawl homepage + common about/careers paths; detect hiring signals (strategy §3.1 / E1.2). */
export async function scrapeCompanyWeb(jobId: string, domain: string): Promise<RawScrapeRecord> {
  const host = normalizeDomain(domain);
  const base = `https://${host}`;
  const homepage = await fetchPage(base);
  const htmlParts: string[] = [];
  let companyName: string | undefined;
  let description: string | undefined;
  let isHiring = false;
  let openJobs = 0;
  const pagesVisited: string[] = [];

  if (homepage) {
    htmlParts.push(homepage.html);
    pagesVisited.push(base);
    const titleMatch = homepage.html.match(/<title[^>]*>([^<]+)<\/title>/i);
    companyName = titleMatch?.[1]?.trim();
    description = metaContent(homepage.html, "description") ?? stripHtml(homepage.html).slice(0, 500);
    if (HIRING_KEYWORDS.test(homepage.html)) {
      isHiring = true;
      openJobs = Math.max(openJobs, countJobListings(homepage.html));
    }
  }

  for (const path of CAREERS_PATHS) {
    const page = await fetchPage(`${base}${path}`);
    if (!page) continue;
    pagesVisited.push(`${base}${path}`);
    htmlParts.push(page.html);
    if (HIRING_KEYWORDS.test(page.html) || path.includes("career") || path.includes("job")) {
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
      companyName,
      description,
      html: combinedHtml.slice(0, 500_000),
      htmlLength: combinedHtml.length,
      isHiring,
      openJobs: openJobs || undefined,
      pagesVisited,
    },
    meta: { statusCode: homepage?.status ?? 0, pages: pagesVisited.length },
  };
}
