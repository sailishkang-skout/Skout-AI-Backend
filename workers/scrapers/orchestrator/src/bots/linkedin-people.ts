import type { RawScrapeRecord } from "@skout/scraper-contracts";
import { fetchPage } from "../proxy-fetch.js";

interface LinkedInAccount {
  cookie?: string;
  li_at?: string;
  userAgent?: string;
}

function parseAccounts(): LinkedInAccount[] {
  const raw = process.env.LINKEDIN_ACCOUNTS_JSON;
  if (!raw || raw === "[]") return [];
  try {
    return JSON.parse(raw) as LinkedInAccount[];
  } catch {
    return [];
  }
}

function companySlug(seed: string): string {
  const m = seed.match(/company\/([^/?#]+)/i);
  if (m) return m[1]!;
  return seed.replace(/^https?:\/\//, "").replace(/linkedin\.com\/?/i, "").split("/")[0] ?? seed;
}

function parsePeopleFromHtml(html: string): Array<{
  fullName?: string;
  title?: string;
  linkedinUrl?: string;
}> {
  const people: Array<{ fullName?: string; title?: string; linkedinUrl?: string }> = [];
  const re =
    /<a[^>]+href="(https?:\/\/[^"]*linkedin\.com\/in\/[^"]+)"[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && people.length < 40) {
    const linkedinUrl = m[1];
    const fullName = m[2]?.trim();
    if (fullName && fullName.length > 2) {
      people.push({ fullName, linkedinUrl });
    }
  }
  return people;
}

/** LinkedIn company people listing (authenticated cookie when available). */
export async function scrapeLinkedInPeople(jobId: string, seed: string): Promise<RawScrapeRecord[]> {
  const accounts = parseAccounts();
  const slug = companySlug(seed);
  const peopleUrl = `https://www.linkedin.com/company/${slug}/people/`;
  const account = accounts[0];
  const cookie = account?.li_at ? `li_at=${account.li_at}` : account?.cookie;

  const page = cookie
    ? await fetchPage(peopleUrl, {
        headers: {
          Cookie: cookie,
          "User-Agent": account?.userAgent ?? process.env.SCRAPER_USER_AGENT ?? "Mozilla/5.0",
        },
      })
    : null;

  if (!page) {
    return [
      {
        jobId,
        source: "linkedin",
        scrapedAt: new Date().toISOString(),
        url: peopleUrl,
        payload: { seed, mode: "people_unavailable", note: "LINKEDIN_ACCOUNTS_JSON required" },
        meta: { skipped: true },
      },
    ];
  }

  const people = parsePeopleFromHtml(page.html);
  const companyDomain = `${slug.replace(/-/g, "")}.com`;

  return people.map((person) => ({
    jobId,
    source: "linkedin",
    scrapedAt: new Date().toISOString(),
    url: peopleUrl,
    payload: {
      ...person,
      companyDomain,
      companyName: slug,
      mode: "people",
    },
    meta: { authenticated: true, peopleCount: people.length },
  }));
}
