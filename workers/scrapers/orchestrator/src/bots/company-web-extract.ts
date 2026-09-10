/** HTML / JSON-LD extraction helpers for company-web bot. */

export interface FirmographicHints {
  companyName?: string;
  description?: string;
  industry?: string;
  employeeCount?: number;
  foundedYear?: number;
  hqCity?: string;
  hqCountry?: string;
  hqState?: string;
  companyStage?: string;
  keywords?: string[];
}

function metaContent(html: string, key: string, attr: "name" | "property" = "name"): string | undefined {
  const re = new RegExp(
    `<meta[^>]+${attr}=["']${key}["'][^>]+content=["']([^"']+)`,
    "i"
  );
  const alt = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${key}["']`,
    "i"
  );
  return html.match(re)?.[1] ?? html.match(alt)?.[1];
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanCompanyName(
  title: string | undefined,
  ogSiteName: string | undefined,
  domain: string
): string | undefined {
  const brand = domain.split(".")[0];
  const candidates = [ogSiteName, title].filter(Boolean) as string[];
  for (const raw of candidates) {
    const cleaned = raw
      .split(/\s*[|\-–—:]\s*/)[0]
      ?.replace(/\s+(Home|Homepage)$/i, "")
      .trim();
    if (cleaned && cleaned.length > 1 && cleaned.length < 80) {
      return cleaned;
    }
  }
  if (brand && brand.length > 1) {
    return brand.charAt(0).toUpperCase() + brand.slice(1);
  }
  return title?.trim();
}

function parseJsonLdBlocks(html: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]!) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object") blocks.push(item as Record<string, unknown>);
        }
      } else if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj["@graph"])) {
          for (const item of obj["@graph"] as unknown[]) {
            if (item && typeof item === "object") blocks.push(item as Record<string, unknown>);
          }
        } else {
          blocks.push(obj);
        }
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return blocks;
}

function orgBlocks(blocks: Record<string, unknown>[]): Record<string, unknown>[] {
  return blocks.filter((b) => {
    const t = b["@type"];
    const types = Array.isArray(t) ? t : [t];
    return types.some((x) => typeof x === "string" && /Organization|Corporation|Company/i.test(x));
  });
}

function parseEmployeeCount(value: unknown): number | undefined {
  if (typeof value === "number" && value > 0) return Math.round(value);
  if (typeof value === "string") {
    const n = Number(value.replace(/,/g, ""));
    if (n > 0) return Math.round(n);
    const range = value.match(/(\d[\d,]*)\s*\+?/);
    if (range) return Number(range[1]!.replace(/,/g, ""));
  }
  return undefined;
}

function parseFoundedYear(value: unknown): number | undefined {
  if (typeof value === "number" && value > 1800 && value < 2100) return value;
  if (typeof value === "string") {
    const y = value.match(/\b(19|20)\d{2}\b/);
    if (y) return Number(y[0]);
  }
  return undefined;
}

function parseAddress(org: Record<string, unknown>): Pick<FirmographicHints, "hqCity" | "hqState" | "hqCountry"> {
  const addr = org.address;
  if (!addr || typeof addr !== "object") return {};
  const a = addr as Record<string, unknown>;
  return {
    hqCity: typeof a.addressLocality === "string" ? a.addressLocality : undefined,
    hqState: typeof a.addressRegion === "string" ? a.addressRegion : undefined,
    hqCountry:
      typeof a.addressCountry === "string"
        ? a.addressCountry.length === 2
          ? a.addressCountry.toUpperCase()
          : a.addressCountry
        : undefined,
  };
}

export function extractFirmographics(html: string, domain: string): FirmographicHints {
  const hints: FirmographicHints = {};
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
  const ogSite = metaContent(html, "og:site_name", "property");
  hints.companyName = cleanCompanyName(title, ogSite, domain);
  hints.description =
    metaContent(html, "description") ??
    metaContent(html, "og:description", "property") ??
    stripHtml(html).slice(0, 500);

  const orgs = orgBlocks(parseJsonLdBlocks(html));
  for (const org of orgs) {
    if (!hints.companyName && typeof org.name === "string") hints.companyName = org.name.trim();
    if (!hints.description && typeof org.description === "string") hints.description = org.description;
    if (!hints.industry && typeof org.industry === "string") hints.industry = org.industry;
    if (!hints.employeeCount) {
      hints.employeeCount =
        parseEmployeeCount(org.numberOfEmployees) ?? parseEmployeeCount(org.employees);
    }
    if (!hints.foundedYear) {
      hints.foundedYear =
        parseFoundedYear(org.foundingDate) ?? parseFoundedYear(org.founded);
    }
    Object.assign(hints, parseAddress(org));
  }

  const text = stripHtml(html);
  if (!hints.employeeCount) {
    const emp = text.match(
      /\b([\d,]{2,})\+?\s*(?:employees|team members|people worldwide|people globally)\b/i
    );
    if (emp) hints.employeeCount = Number(emp[1]!.replace(/,/g, ""));
  }
  if (!hints.foundedYear) {
    const founded = text.match(/\bfounded\s+(?:in\s+)?((?:19|20)\d{2})\b/i);
    if (founded) hints.foundedYear = Number(founded[1]);
  }
  if (!hints.industry) {
    const ind = metaContent(html, "keywords");
    if (ind) {
      hints.keywords = ind.split(/[,;]/).map((k) => k.trim()).filter(Boolean).slice(0, 8);
      hints.industry = hints.keywords[0];
    }
  }

  if (/\bIPO\b|publicly traded|NASDAQ|NYSE/i.test(text)) {
    hints.companyStage = "public";
  } else if (/\bSeries [A-D]\b/i.test(text)) {
    hints.companyStage = "series_a";
  } else if (/\bseed round\b/i.test(text)) {
    hints.companyStage = "seed";
  }

  return hints;
}

export function countJobListings(html: string): number {
  const lower = html.toLowerCase();
  const listings = lower.match(/data-job-id|job-posting|opening[s]?|position[s]?/gi);
  return Math.min(listings?.length ?? 0, 50);
}

export const HIRING_KEYWORDS =
  /\b(careers?|we(?:'re| are) hiring|open roles?|job openings?|join our team|view positions|see open roles)\b/i;

const DEPT_PATTERNS: Array<[string, RegExp]> = [
  ["Engineering", /\b(engineering|software|developer|platform)\b/gi],
  ["Sales", /\b(sales|account executive|business development)\b/gi],
  ["Marketing", /\b(marketing|growth|content)\b/gi],
  ["Product", /\b(product manager|product design)\b/gi],
  ["Operations", /\b(operations|finance|legal|hr|people)\b/gi],
];

/** Best-effort department counts from careers page HTML. */
export function extractHiringByDept(html: string): Record<string, number> {
  const text = stripHtml(html);
  const counts: Record<string, number> = {};
  for (const [dept, pattern] of DEPT_PATTERNS) {
    const matches = text.match(pattern);
    if (matches?.length) counts[dept] = Math.min(matches.length, 25);
  }
  return counts;
}

export const CAREERS_PATHS = [
  "/careers",
  "/jobs",
  "/join-us",
  "/work-with-us",
  "/about",
  "/about-us",
  "/company",
  "/team",
  "/leadership",
  "/our-team",
  "/people",
];
