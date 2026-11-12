// cSpell:ignore wiza datagma contactout linkedin
import { createHash } from "node:crypto";
import { generateCompanyId, normalizeDomain } from "@skout/shared";
import type { ProspectDocument, SearchFilters } from "@skout/opensearch";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";

const log = createLogger("vendor-search.service");

/** Vendors that offer a people-search API we can call. Datagma has no find_people route on its
 *  gateway for our account (404), so it is used for phone reveal only. */
export type VendorName = "wiza" | "contactout";

/** A person as returned by a vendor search — identity/company only, no contact details. */
export interface VendorPerson {
  vendor: VendorName;
  fullName: string;
  title?: string;
  linkedinUrl?: string;
  companyName?: string;
  companyDomain?: string;
  industry?: string;
  country?: string;
  location?: string;
  seniority?: string;
  employeeCount?: number;
}

export interface VendorSearchOutcome {
  people: VendorPerson[];
  /** Largest total-match count any vendor reported (undefined if none reported one). */
  total?: number;
  /** Vendors that were attempted, and which of them errored. */
  attempted: VendorName[];
  failed: { vendor: VendorName; error: string }[];
}

type Json = Record<string, unknown>;

const TIMEOUT_MS = 15_000;

function isLive(key: string | undefined): key is string {
  if (!key?.trim()) return false;
  return !["replace-me", "changeme", "placeholder"].includes(key.trim().toLowerCase());
}

/** Vendors we have a live key for. */
export function enabledVendors(env: Env): VendorName[] {
  const out: VendorName[] = [];
  if (isLive(env.WIZA_API_KEY)) out.push("wiza");
  if (isLive(env.CONTACTOUT_API_KEY)) out.push("contactout");
  return out;
}

async function http<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${new URL(url).host}`);
  return (await res.json()) as T;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const root = (u: string) => u.replace(/\/$/, "");

/** Wiza returns LinkedIn URLs without a scheme; the UI needs a clickable absolute URL. */
const absoluteUrl = (v: string | undefined): string | undefined =>
  v ? (/^https?:\/\//i.test(v) ? v : `https://${v.replace(/^\/+/, "")}`) : undefined;

// ---------------------------------------------------------------------------
// Filter translation helpers
// ---------------------------------------------------------------------------

/** Skout seniority → Wiza job_title_level. */
const WIZA_LEVEL: Record<string, string> = {
  founder: "Owner",
  co_founder: "Owner",
  ceo: "CXO",
  c_level: "CXO",
  vp: "VP",
  director: "Director",
  head: "Director",
  manager: "Manager",
  individual_contributor: "Senior",
};

/** Skout seniority → ContactOut seniority. */
const CONTACTOUT_LEVEL: Record<string, string> = {
  founder: "Owner",
  co_founder: "Owner",
  ceo: "C-Level",
  c_level: "C-Level",
  vp: "VP",
  director: "Director",
  head: "Director",
  manager: "Manager",
  individual_contributor: "Senior",
};

function seniorities(f: SearchFilters): string[] {
  return [...new Set([f.seniority, ...(f.seniorities ?? [])].filter((s): s is string => !!s))];
}

function countries(f: SearchFilters): string[] {
  return [...new Set([f.country, ...(f.countries ?? [])].filter((s): s is string => !!s))];
}

/** Free-text hint used when no structured title was extracted. */
function titleTerm(f: SearchFilters): string | undefined {
  return str(f.jobTitle);
}

function locationParts(f: SearchFilters): string[] {
  const city = str(f.city);
  const state = str(f.state);
  const cs = countries(f);
  if (city) return [[city, state, cs[0]].filter(Boolean).join(", ")];
  if (state) return [[state, cs[0]].filter(Boolean).join(", ")];
  return cs;
}

// ---------------------------------------------------------------------------
// Wiza — POST /api/prospects/search (free; masked profiles, up to 30)
// ---------------------------------------------------------------------------

export function buildWizaFilters(f: SearchFilters): Json {
  const filters: Json = {};
  const title = titleTerm(f);
  if (title) filters.job_title = [{ v: title, s: "i" }];
  const levels = [...new Set(seniorities(f).map((s) => WIZA_LEVEL[s]).filter(Boolean))];
  if (levels.length) filters.job_title_level = levels;

  const loc: { v: string; b: string; s: string }[] = [];
  const city = str(f.city);
  const state = str(f.state);
  const cs = countries(f);
  if (city) loc.push({ v: [city, state, cs[0]].filter(Boolean).join(", "), b: "city", s: "i" });
  else if (state) loc.push({ v: [state, cs[0]].filter(Boolean).join(", "), b: "state", s: "i" });
  else for (const c of cs) loc.push({ v: c, b: "country", s: "i" });
  if (loc.length) filters.location = loc;

  const company = str(f.companyName);
  if (company) filters.job_company = [{ v: company, s: "i" }];

  const name = str(f.fullName);
  if (name) {
    const [first, ...rest] = name.split(/\s+/);
    if (first) filters.first_name = [first];
    if (rest.length) filters.last_name = [rest.join(" ")];
  }
  return filters;
}

interface VendorPage {
  people: VendorPerson[];
  total?: number;
}

/** Wiza's search returns at most 30 people per call and has no offset or cursor. */
const WIZA_MAX_RESULTS = 30;

/**
 * Wiza only serves page 1. We always ask for its maximum (30) regardless of the UI page size, so
 * one search stores everything Wiza will give for those filters and page 2 onward is answered
 * from our own index. The reported total is capped at 30 because that is all we can ever reach:
 * Wiza's own total (e.g. 41) would otherwise promise pages that come back empty.
 */
async function searchWiza(env: Env, f: SearchFilters, size: number, page: number): Promise<VendorPage> {
  const filters = buildWizaFilters(f);
  if (page > 1 || Object.keys(filters).length === 0) return { people: [] };
  const body = await http<{ data?: { profiles?: Json[]; total?: number } }>(
    `${root(env.WIZA_BASE_URL)}/api/prospects/search`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${env.WIZA_API_KEY}`,
      },
      body: JSON.stringify({ filters, size: WIZA_MAX_RESULTS }),
    }
  );
  const out: VendorPerson[] = [];
  for (const p of body.data?.profiles ?? []) {
    const fullName = str(p.full_name);
    if (!fullName) continue;
    out.push({
      vendor: "wiza",
      fullName,
      title: str(p.job_title) ?? str(p.title),
      linkedinUrl: absoluteUrl(str(p.linkedin_url)),
      companyName: str(p.job_company_name) ?? str(p.company),
      companyDomain: str(p.job_company_website),
      industry: str(p.industry),
      location: str(p.location_name),
    });
  }
  const reachable = typeof body.data?.total === "number" ? Math.min(body.data.total, WIZA_MAX_RESULTS) : undefined;
  return { people: out, total: reachable };
}

// ---------------------------------------------------------------------------
// ContactOut — POST /v1/people/search (1 search credit per profile; no reveal)
// ---------------------------------------------------------------------------

export function buildContactOutBody(f: SearchFilters, size: number, page: number): Json {
  const body: Json = { page, page_size: Math.min(size, 25), reveal_info: false };
  const name = str(f.fullName);
  if (name) body.name = name;
  const title = titleTerm(f);
  if (title) body.job_title = [title];
  const levels = [...new Set(seniorities(f).map((s) => CONTACTOUT_LEVEL[s]).filter(Boolean))];
  if (levels.length) body.seniority = levels;
  const loc = locationParts(f);
  if (loc.length) body.location = loc;
  const company = str(f.companyName);
  if (company) body.company = [company];
  const domain = str(f.companyDomain);
  if (domain) body.domain = [normalizeDomain(domain)];
  const industries = [...new Set([f.industry, ...(f.industries ?? [])].filter((s): s is string => !!s))];
  if (industries.length) body.industry = industries;
  const keyword = str(f.keyword);
  if (keyword) body.keyword = keyword;
  return body;
}

async function searchContactOut(env: Env, f: SearchFilters, size: number, page: number): Promise<VendorPage> {
  const reqBody = buildContactOutBody(f, size, page);
  if (Object.keys(reqBody).length <= 3) return { people: [] }; // only page/page_size/reveal_info → too broad to bill
  const body = await http<{
    message?: string;
    metadata?: { total_results?: number };
    profiles?: Record<string, Json> | Json[];
  }>(
    `${root(env.CONTACTOUT_BASE_URL)}/v1/people/search`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        token: env.CONTACTOUT_API_KEY!,
      },
      body: JSON.stringify(reqBody),
    }
  );
  // A sample-only key returns fabricated people with this message — never accept or store them.
  if (/sample response/i.test(body.message ?? "")) {
    throw new Error("ContactOut key is sample-only (returns fake profiles); upgrade the plan or use a full-access key");
  }
  // Documented as an object keyed by LinkedIn URL; tolerate an array too.
  const entries: [string | undefined, Json][] = Array.isArray(body.profiles)
    ? body.profiles.map((p) => [undefined, p])
    : Object.entries(body.profiles ?? {});
  const out: VendorPerson[] = [];
  for (const [key, p] of entries) {
    const fullName = str(p.full_name);
    if (!fullName) continue;
    const company = (p.company ?? {}) as Json;
    const li = key && /linkedin\.com/i.test(key) ? key : str(p.li_vanity) ? `https://www.linkedin.com/in/${str(p.li_vanity)}` : undefined;
    out.push({
      vendor: "contactout",
      fullName,
      title: str(p.title) ?? str(p.headline),
      linkedinUrl: li,
      companyName: str(company.name),
      companyDomain: str(company.domain),
      industry: str(p.industry) ?? str(company.industry),
      country: str(p.country),
      location: str(p.location),
      seniority: str(p.seniority),
    });
  }
  return { people: out, total: body.metadata?.total_results };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Stable key for de-duplicating the same person across vendors. */
export function personKey(p: VendorPerson): string {
  const li = p.linkedinUrl?.toLowerCase().match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
  if (li) return `li:${li}`;
  return `nm:${p.fullName.toLowerCase()}|${(p.companyDomain ?? p.companyName ?? "").toLowerCase()}`;
}

/** Merge people across vendors; first vendor to supply a field wins, gaps are back-filled. */
export function mergePeople(people: VendorPerson[]): (VendorPerson & { vendors: VendorName[] })[] {
  const map = new Map<string, VendorPerson & { vendors: VendorName[] }>();
  for (const p of people) {
    const k = personKey(p);
    const cur = map.get(k);
    if (!cur) {
      map.set(k, { ...p, vendors: [p.vendor] });
      continue;
    }
    for (const field of Object.keys(p) as (keyof VendorPerson)[]) {
      if (cur[field] == null && p[field] != null) (cur as unknown as Record<string, unknown>)[field] = p[field];
    }
    if (!cur.vendors.includes(p.vendor)) cur.vendors.push(p.vendor);
  }
  return [...map.values()];
}

export async function searchVendors(
  env: Env,
  filters: SearchFilters,
  pageSize: number,
  page = 1
): Promise<VendorSearchOutcome> {
  const attempted = enabledVendors(env);
  const tasks: Record<VendorName, () => Promise<VendorPage>> = {
    wiza: () => searchWiza(env, filters, pageSize, page),
    contactout: () => searchContactOut(env, filters, pageSize, page),
  };
  const settled = await Promise.allSettled(attempted.map((v) => tasks[v]()));
  const people: VendorPerson[] = [];
  const failed: VendorSearchOutcome["failed"] = [];
  let total: number | undefined;
  settled.forEach((r, i) => {
    const vendor = attempted[i]!;
    if (r.status === "fulfilled") {
      people.push(...r.value.people);
      if (r.value.total != null) total = Math.max(total ?? 0, r.value.total);
    } else {
      const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
      log.error("vendor search failed", r.reason, { vendor });
      failed.push({ vendor, error });
    }
  });
  return { people: mergePeople(people), total, attempted, failed };
}

/** Deterministic id from the LinkedIn slug (or name+company) so re-searches upsert, not duplicate. */
export function vendorProspectId(p: VendorPerson): string {
  return createHash("sha256").update(`vendor:${personKey(p)}`).digest("hex");
}

export function toProspectDocument(p: VendorPerson & { vendors?: VendorName[] }): ProspectDocument {
  const domain = p.companyDomain ? normalizeDomain(p.companyDomain) : "";
  const companyId = domain
    ? generateCompanyId(domain)
    : createHash("sha256").update(`vendor-company:${(p.companyName ?? p.fullName).toLowerCase()}`).digest("hex");
  const lastPart = p.location?.split(",").pop()?.trim();
  return {
    prospectId: vendorProspectId(p),
    companyId,
    fullName: p.fullName,
    title: p.title,
    seniority: p.seniority?.toLowerCase().replace(/[\s-]+/g, "_"),
    linkedinUrl: p.linkedinUrl,
    // Placeholder when the vendor gave no website: the enrichment engine treats this as a
    // LinkedIn-only identity (resolves via profile URL / company name) and the API requires a value.
    companyDomain: domain || "linkedin-capture.local",
    companyName: p.companyName,
    industry: p.industry,
    country: p.country ?? lastPart,
    city: p.location?.split(",")[0]?.trim(),
    employeeCount: p.employeeCount,
    dataSource: "vendor",
    dataVendors: p.vendors ?? [p.vendor],
    updatedAt: new Date().toISOString(),
  };
}
