import type { RawScrapeRecord } from "@skout/scraper-contracts";
import { fetchPageSmart } from "../proxy-fetch.js";

function slugFromSeed(seed: string): string {
  const m = seed.match(/organization\/([^/?#]+)/i);
  if (m) return m[1]!;
  return seed.replace(/^https?:\/\//, "").replace(/crunchbase\.com\/?/i, "").split("/")[0] ?? seed;
}

/** Crunchbase public org page scrape for funding signals (E5.2). */
export async function scrapeCrunchbase(jobId: string, seed: string): Promise<RawScrapeRecord[]> {
  const slug = slugFromSeed(seed);
  const url = `https://www.crunchbase.com/organization/${slug}`;
  const page = await fetchPageSmart(url);
  if (!page) {
    return [
      {
        jobId,
        source: "crunchbase",
        scrapedAt: new Date().toISOString(),
        payload: { seed, note: "crunchbase fetch failed" },
        meta: { skipped: true },
      },
    ];
  }

  const html = page.html;
  const name = html.match(/<title[^>]*>([^<|]+)/i)?.[1]?.trim();
  const lastRound =
    html.match(/Last funding type[^<]*<[^>]*>([^<]+)/i)?.[1]?.trim() ??
    html.match(/"last_funding_type":"([^"]+)"/i)?.[1];
  const lastRoundDate =
    html.match(/Announced Date[^<]*<[^>]*>([^<]+)/i)?.[1]?.trim() ??
    html.match(/"announced_on":"([^"]+)"/i)?.[1];
  const totalRaisedMatch = html.match(/\$([\d.]+)([MBK])\s+Total Funding/i);
  let totalRaised: number | undefined;
  if (totalRaisedMatch) {
    const n = Number(totalRaisedMatch[1]);
    const mult = totalRaisedMatch[2] === "B" ? 1e9 : totalRaisedMatch[2] === "M" ? 1e6 : 1e3;
    totalRaised = Math.round(n * mult);
  }

  const employeeMatch = html.match(/Number of Employees[^<]*<[^>]*>([\d,]+)/i);
  const employeeCount = employeeMatch ? Number(employeeMatch[1]!.replace(/,/g, "")) : undefined;

  return [
    {
      jobId,
      source: "crunchbase",
      scrapedAt: new Date().toISOString(),
      url,
      payload: {
        domain: `${slug}.com`,
        companyName: name,
        employeeCount,
        funding: {
          lastRound,
          lastRoundDate: lastRoundDate?.slice(0, 10),
          totalRaised,
        },
        companyStage: lastRound?.toLowerCase().includes("series") ? "series_a" : undefined,
        html: html.slice(0, 150_000),
      },
      meta: { statusCode: page.status },
    },
  ];
}
