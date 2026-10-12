import { createHash } from "node:crypto";

/**
 * ENR-02 — canonical LinkedIn identity keys and capture merge rules, ported from the
 * EnrichmentTool prototype (`backend/src/lib`). Pure functions; no database access.
 */

const LINKEDIN_HOSTS = new Set(["www.linkedin.com", "linkedin.com"]);

function linkedinPathParts(value: string): string[] | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !LINKEDIN_HOSTS.has(url.hostname)) return undefined;
    return url.pathname.split("/").filter(Boolean);
  } catch {
    return undefined;
  }
}

/** LinkedIn ids are case-insensitive and may arrive percent-encoded. */
export function normalizeLinkedinId(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // keep the raw segment
  }
  return decoded.trim().toLowerCase();
}

/** Public id of a real `https://www.linkedin.com/in/<id>/` URL; nothing else qualifies. */
export function publicIdFromProfileUrl(value: string): string | undefined {
  const parts = linkedinPathParts(value);
  if (!parts || parts[0] !== "in" || !parts[1] || parts.length !== 2) return undefined;
  return normalizeLinkedinId(parts[1]);
}

/** Opaque lead id of a `https://www.linkedin.com/sales/lead/<id>,...` URL. */
export function salesLeadIdFromUrl(value: string): string | undefined {
  const parts = linkedinPathParts(value);
  if (!parts || parts[0] !== "sales" || parts[1] !== "lead" || !parts[2]) return undefined;
  return parts[2].split(",")[0] || undefined;
}

export function companyIdFromCompanyUrl(value: string): string | undefined {
  const parts = linkedinPathParts(value);
  if (!parts || parts[0] !== "company" || !parts[1]) return undefined;
  return normalizeLinkedinId(parts[1]);
}

export function isSalesNavigatorUrl(value: string): boolean {
  const parts = linkedinPathParts(value);
  return !!parts && parts[0] === "sales";
}

export const personPublicKey = (publicId: string) => `in:${normalizeLinkedinId(publicId)}`;
export const salesLeadKey = (leadId: string) => `sales-lead:${leadId}`;
export const companyPublicKey = (publicId: string) => `company:${normalizeLinkedinId(publicId)}`;
export const companyMemberKey = (memberId: string) => `company-member:${memberId.trim()}`;

export function canonicalPublicProfileUrl(publicId: string): string {
  return `https://www.linkedin.com/in/${normalizeLinkedinId(publicId)}/`;
}

/** Stable workspace prospect id for a record first seen under `canonicalKey`. */
export function prospectIdForCanonicalKey(canonicalKey: string): string {
  return createHash("sha256").update(`linkedin:${canonicalKey}`).digest("hex");
}

export interface CompanyLike {
  publicId?: string | null;
  memberId?: string | null;
  name?: string | null;
  website?: string | null;
  domain?: string | null;
  industry?: string | null;
  headquarter?: string | null;
}

export function normalizedCompanyName(value?: string | null): string | undefined {
  const normalized = value
    ?.toLocaleLowerCase()
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|company|co)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

export function domainFromCompany(value: Pick<CompanyLike, "website" | "domain">): string | undefined {
  const raw = value.domain || value.website;
  if (!raw) return undefined;
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return (
      raw
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .split("/")[0]
        ?.toLowerCase() || undefined
    );
  }
}

export function companyMatchScore(existing: CompanyLike, incoming: CompanyLike): number {
  if (existing.publicId && incoming.publicId && existing.publicId === incoming.publicId) return 1000;
  if (existing.memberId && incoming.memberId && existing.memberId === incoming.memberId) return 950;
  const existingDomain = domainFromCompany(existing);
  const incomingDomain = domainFromCompany(incoming);
  const sameDomain = !!existingDomain && existingDomain === incomingDomain;
  const sameName =
    !!normalizedCompanyName(existing.name) &&
    normalizedCompanyName(existing.name) === normalizedCompanyName(incoming.name);
  const same = (a?: string | null, b?: string | null) =>
    !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  if (sameDomain && sameName) return 900;
  if (sameDomain) return 650;
  if (sameName && (same(existing.industry, incoming.industry) || same(existing.headquarter, incoming.headquarter)))
    return 300;
  return 0;
}

/** Names alone never merge two companies. */
export function isSameCompany(existing: CompanyLike, incoming: CompanyLike): boolean {
  return companyMatchScore(existing, incoming) >= 300;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** Prefer stable job ids; relative posting text changes on every visit. */
export function mergeJobs(stored: Json[], incoming: Json[]): Json[] {
  const jobs = new Map<string, Json>();
  const lower = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : undefined);
  const signature = (job: Json) => JSON.stringify([lower(job.title), lower(job.location)]);
  for (const job of [...stored, ...incoming]) {
    const key = job.jobId ? `id:${String(job.jobId)}` : `text:${signature(job)}`;
    const defined = Object.fromEntries(
      Object.entries(job).filter(([, value]) => value !== undefined && value !== null && value !== "")
    );
    jobs.set(key, { ...jobs.get(key), ...defined });
  }
  // Upgrade a placeholder only when exactly one identified job matches it.
  for (const [key, job] of jobs) {
    if (job.jobId) continue;
    const matches = [...jobs.entries()].filter(([, other]) => other.jobId && signature(other) === signature(job));
    if (matches.length === 1) {
      const [identifiedKey, identified] = matches[0]!;
      jobs.set(identifiedKey, { ...job, ...identified });
      jobs.delete(key);
    }
  }
  return [...jobs.values()];
}

/** Captures are partial observations of loaded tabs, not complete inventories. */
export function mergeCompanyCapture(stored: Json, incoming: Json): Json {
  const merged: Json = {
    ...stored,
    ...Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined)),
  };
  for (const [field, identity] of Object.entries({ recentPosts: "activityId", products: "slug" })) {
    const next = records(incoming[field]);
    if (next.length === 0) continue;
    const seen = new Set<string>();
    const items = [...next, ...records(stored[field])].filter((item) => {
      const key = String(
        item[identity] || item.postUrl || item.productUrl || `${item.title}|${item.location}|${item.postedText}`
      );
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    merged[field] = field === "recentPosts" ? items.slice(0, 6) : items;
  }
  if (records(incoming.openJobs).length) {
    merged.openJobs = mergeJobs(records(stored.openJobs), records(incoming.openJobs));
  }
  if (isRecord(incoming.peopleStats) && isRecord(stored.peopleStats)) {
    merged.peopleStats = {
      ...stored.peopleStats,
      ...incoming.peopleStats,
      breakdowns: {
        ...(isRecord(stored.peopleStats.breakdowns) ? stored.peopleStats.breakdowns : {}),
        ...(isRecord(incoming.peopleStats.breakdowns) ? incoming.peopleStats.breakdowns : {}),
      },
    };
  }
  if (isRecord(incoming.sectionCaptures)) {
    const sections: Json = { ...(isRecord(stored.sectionCaptures) ? stored.sectionCaptures : {}) };
    const isHome = (source: unknown) => {
      try {
        return /^\/company\/[^/]+\/?$/.test(new URL(String(source)).pathname);
      } catch {
        return false;
      }
    };
    for (const [key, value] of Object.entries(incoming.sectionCaptures)) {
      if (!isRecord(value)) continue;
      const previous = isRecord(sections[key]) ? sections[key] : undefined;
      // Preserve a detailed tab capture when Home only shows a preview.
      if (previous && value.method === "rendered-dom" && isHome(value.sourceUrl) && !isHome(previous.sourceUrl)) continue;
      if (previous?.method === "reviewed-text" && value.method === "rendered-dom") continue;
      sections[key] = value;
    }
    merged.sectionCaptures = sections;
  }
  return merged;
}

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (isRecord(value)) {
    const sorted: Json = {};
    for (const key of Object.keys(value).sort()) sorted[key] = normalizeForHash(value[key]);
    return sorted;
  }
  return value;
}

/** Key-order-independent hash, so re-serialized captures never produce a false change. */
export function hashValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  return createHash("sha256").update(JSON.stringify(normalizeForHash(value))).digest("hex");
}

export function hashRecord(record: Json): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, hashValue(value)]));
}
