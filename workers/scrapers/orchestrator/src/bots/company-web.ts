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

/** Crawl a company website and emit a RawScrapeRecord (strategy §3.1 / E1.2). */
export async function scrapeCompanyWeb(jobId: string, domain: string): Promise<RawScrapeRecord> {
  const url = domain.startsWith("http") ? domain : `https://${domain}`;
  const res = await fetch(url, {
    headers: { "User-Agent": process.env.SCRAPER_USER_AGENT ?? "SkoutBot/1.0 (+https://skout.ai)" },
    signal: AbortSignal.timeout(Number(process.env.SCRAPER_REQUEST_TIMEOUT_MS ?? 15000)),
  });
  const html = await res.text();
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const description = metaContent(html, "description") ?? stripHtml(html).slice(0, 500);

  return {
    jobId,
    source: "company-web",
    scrapedAt: new Date().toISOString(),
    url,
    payload: {
      domain: domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0],
      companyName: titleMatch?.[1]?.trim(),
      description,
      htmlLength: html.length,
    },
    meta: { statusCode: res.status },
  };
}
