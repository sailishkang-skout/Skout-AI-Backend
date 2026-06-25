import { createHash } from "node:crypto";
import type { ProspectDocument, SearchFilters } from "./index.js";

const INDUSTRIES = [
  "Software & SaaS",
  "FinTech",
  "Healthcare",
  "Retail & E-Commerce",
  "Manufacturing",
  "Cybersecurity",
  "HR Tech",
  "EdTech",
  "Logistics",
  "Legal Tech",
];
const COUNTRIES = ["US", "DE", "GB", "FR", "CA", "AU", "IN", "SG", "NL", "IE"];
const CITIES = [
  "San Francisco",
  "New York",
  "London",
  "Berlin",
  "Toronto",
  "Austin",
  "Chicago",
  "Boston",
  "Seattle",
  "Mumbai",
];
const STATES = ["CA", "NY", "TX", "WA", "ON", "MA", "IL", "CO", "GA", "FL"];
const STAGES = ["seed", "series_a", "series_b", "bootstrapped", "public"];
const SENIORITIES = ["vp", "director", "manager", "c_level", "founder", "head", "individual_contributor"];
const DEPARTMENTS = ["Sales", "Marketing", "Engineering", "Product", "Operations", "Finance"];
const JOB_FUNCTIONS = ["AE", "SDR", "Demand Generation", "RevOps", "Growth", "Recruiting"];
const FIRST_NAMES = [
  "Alex",
  "Jordan",
  "Taylor",
  "Morgan",
  "Casey",
  "Riley",
  "Sam",
  "Avery",
  "Quinn",
  "Blake",
  "Drew",
  "Jamie",
];
const LAST_NAMES = [
  "Chen",
  "Patel",
  "Nguyen",
  "Brooks",
  "Kim",
  "Martinez",
  "Singh",
  "Okafor",
  "Andersen",
  "Silva",
  "Khan",
  "Fischer",
];
const TITLES = [
  "VP Sales",
  "Director of Marketing",
  "Head of Growth",
  "Chief Revenue Officer",
  "Sales Manager",
  "Account Executive",
  "SDR Manager",
  "Director of Demand Gen",
  "VP Customer Success",
  "RevOps Lead",
];

/** Dedupe / per-company caps applied after query filters. */
export function postProcessSearchHits(
  hits: ProspectDocument[],
  filters: Pick<SearchFilters, "excludeDuplicates" | "maxPerCompany">
): ProspectDocument[] {
  let result = hits;
  if (filters.excludeDuplicates) {
    const seen = new Set<string>();
    result = result.filter((d) => {
      const key = d.email?.toLowerCase() || `${d.companyDomain}|${d.fullName ?? ""}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (filters.maxPerCompany != null && filters.maxPerCompany > 0) {
    const counts = new Map<string, number>();
    result = result.filter((d) => {
      const n = counts.get(d.companyDomain) ?? 0;
      if (n >= filters.maxPerCompany!) return false;
      counts.set(d.companyDomain, n + 1);
      return true;
    });
  }
  return result;
}

/** Synthetic corpus for local dev when OpenSearch is empty or unreachable. */
export function buildDemoCorpus(count = 5300): ProspectDocument[] {
  const now = new Date().toISOString();
  const companyCount = Math.max(120, Math.ceil(count / 25));
  return Array.from({ length: count }, (_, i) => ({
    prospectId: createHash("sha256").update(`demo-prospect-${i}`).digest("hex"),
    companyId: createHash("sha256").update(`demo-company-${i % companyCount}`).digest("hex"),
    fullName: `${FIRST_NAMES[i % FIRST_NAMES.length]} ${LAST_NAMES[(i + 3) % LAST_NAMES.length]}`,
    title: TITLES[i % TITLES.length],
    seniority: SENIORITIES[i % SENIORITIES.length],
    department: DEPARTMENTS[i % DEPARTMENTS.length],
    jobFunction: JOB_FUNCTIONS[i % JOB_FUNCTIONS.length],
    email: i % 3 !== 0 ? `prospect${i}@example${(i % 10) + 1}.com` : undefined,
    phone: i % 4 === 0 ? `+1-555-${String(i).padStart(4, "0")}` : undefined,
    linkedinUrl: i % 2 === 0 ? `https://linkedin.com/in/demo-prospect-${i}` : undefined,
    companyDomain: `example${(i % companyCount) + 1}.com`,
    companyName: `Example Corp ${(i % companyCount) + 1}`,
    industry: INDUSTRIES[i % INDUSTRIES.length],
    country: COUNTRIES[i % COUNTRIES.length],
    state: STATES[i % STATES.length],
    city: CITIES[i % CITIES.length],
    employeeCount: 50 + i * 25,
    companyStage: STAGES[i % STAGES.length],
    annualRevenue: (i + 1) * 500_000,
    lastFundingRound: i % 3 === 0 ? "series_a" : i % 3 === 1 ? "seed" : "series_b",
    currentlyHiring: i % 2 === 0,
    yearsAtCompany: 1 + (i % 8),
    yearsInRole: 1 + (i % 4),
    totalYearsExperience: 2 + (i % 15),
    foundedYear: 1995 + (i % 28),
    headcountGrowth: (i % 25) - 5,
    companyEmailProvider:
      i % 3 === 0 ? "google_workspace" : i % 3 === 1 ? "microsoft_365" : "other",
    intentScore: 15 + (i % 85),
    previousCompany: i % 5 === 0 ? `Previous Corp ${i}` : undefined,
    techStack:
      i % 3 === 0
        ? [{ category: "CRM", technology: "HubSpot" }]
        : i % 3 === 1
          ? [{ category: "CRM", technology: "Salesforce" }]
          : [],
    signals: [
      ...(i % 4 === 0 ? [{ type: "hiring", observedAt: now, detail: "SDR roles posted" }] : []),
      ...(i % 5 === 0 ? [{ type: "recently_promoted", observedAt: now }] : []),
      ...(i % 6 === 0 ? [{ type: "changed_jobs", observedAt: now }] : []),
      ...(i % 7 === 0 ? [{ type: "posted_on_linkedin", observedAt: now }] : []),
      ...(i % 8 === 0 ? [{ type: "active_on_social_media", observedAt: now }] : []),
    ],
    updatedAt: now,
  }));
}

function matchesQuery(doc: ProspectDocument, query: string): boolean {
  const q = query.toLowerCase();
  const haystack = [
    doc.fullName,
    doc.title,
    doc.companyName,
    doc.companyDomain,
    doc.industry,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

/** Apply smart-list filters to the demo corpus (best-effort, case-insensitive). */
export function filterDemoCorpus(
  docs: ProspectDocument[],
  filters: SearchFilters,
  limit = 1000
): ProspectDocument[] {
  let result = docs;

  if (filters.query?.trim()) {
    result = result.filter((d) => matchesQuery(d, filters.query!.trim()));
  }
  // Contact information
  if (filters.fullName?.trim()) {
    const v = filters.fullName.trim().toLowerCase();
    result = result.filter((d) => d.fullName?.toLowerCase().includes(v));
  }
  if (filters.jobTitle?.trim()) {
    const v = filters.jobTitle.trim().toLowerCase();
    result = result.filter((d) => d.title?.toLowerCase().includes(v));
  }
  if (filters.department) {
    const v = filters.department.toLowerCase();
    result = result.filter((d) => d.department?.toLowerCase() === v);
  }
  if (filters.seniority) {
    const v = filters.seniority.toLowerCase();
    result = result.filter((d) => d.seniority?.toLowerCase() === v);
  }
  if (filters.jobFunction) {
    const v = filters.jobFunction.toLowerCase();
    result = result.filter((d) => d.jobFunction?.toLowerCase() === v);
  }
  if (filters.emailAvailable === true) {
    result = result.filter((d) => !!d.email);
  }
  if (filters.phoneAvailable === true) {
    result = result.filter((d) => !!d.phone);
  }
  if (filters.linkedInAvailable === true) {
    result = result.filter((d) => !!d.linkedinUrl);
  }

  // Experience
  if (filters.minYearsAtCompany != null) {
    result = result.filter((d) => (d.yearsAtCompany ?? 0) >= filters.minYearsAtCompany!);
  }
  if (filters.minYearsInRole != null) {
    result = result.filter((d) => (d.yearsInRole ?? 0) >= filters.minYearsInRole!);
  }
  if (filters.minTotalYearsExperience != null) {
    result = result.filter(
      (d) => (d.totalYearsExperience ?? 0) >= filters.minTotalYearsExperience!
    );
  }
  if (filters.previousCompany?.trim()) {
    const v = filters.previousCompany.trim().toLowerCase();
    result = result.filter((d) => d.previousCompany?.toLowerCase().includes(v));
  }

  // Activity signals (OR — match any selected)
  if (filters.contactSignals?.length) {
    const selected = new Set(filters.contactSignals);
    result = result.filter((d) => d.signals?.some((s) => selected.has(s.type)));
  }

  // Company — basic
  if (filters.companyName?.trim()) {
    const v = filters.companyName.trim().toLowerCase();
    result = result.filter((d) => d.companyName?.toLowerCase().includes(v));
  }
  if (filters.companyDomain?.trim()) {
    const v = filters.companyDomain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .split("/")[0];
    result = result.filter((d) => d.companyDomain?.toLowerCase().includes(v));
  }
  if (filters.keyword?.trim()) {
    const v = filters.keyword.trim().toLowerCase();
    result = result.filter(
      (d) =>
        d.industry?.toLowerCase().includes(v) ||
        d.subIndustry?.toLowerCase().includes(v) ||
        d.companyName?.toLowerCase().includes(v)
    );
  }
  if (filters.industry) {
    const v = filters.industry.toLowerCase();
    result = result.filter((d) => d.industry?.toLowerCase() === v);
  }
  if (filters.subIndustry) {
    const v = filters.subIndustry.toLowerCase();
    result = result.filter((d) => d.subIndustry?.toLowerCase() === v);
  }
  if (filters.country) {
    const v = filters.country.toLowerCase();
    result = result.filter((d) => d.country?.toLowerCase() === v);
  }
  if (filters.state) {
    const v = filters.state.toLowerCase();
    result = result.filter((d) => d.state?.toLowerCase() === v);
  }
  if (filters.city?.trim()) {
    const v = filters.city.trim().toLowerCase();
    result = result.filter((d) => d.city?.toLowerCase().includes(v));
  }
  if (filters.minEmployees != null) {
    result = result.filter((d) => (d.employeeCount ?? 0) >= filters.minEmployees!);
  }
  if (filters.maxEmployees != null) {
    result = result.filter((d) => (d.employeeCount ?? 0) <= filters.maxEmployees!);
  }

  // Company — stage & funding
  if (filters.companyStage) {
    result = result.filter((d) => d.companyStage === filters.companyStage);
  }
  if (filters.lastFundingRound) {
    result = result.filter((d) => d.lastFundingRound === filters.lastFundingRound);
  }
  if (filters.minRevenue != null) {
    result = result.filter((d) => (d.annualRevenue ?? 0) >= filters.minRevenue!);
  }
  if (filters.maxRevenue != null) {
    result = result.filter((d) => (d.annualRevenue ?? 0) <= filters.maxRevenue!);
  }
  if (filters.minFoundedYear != null) {
    result = result.filter((d) => (d.foundedYear ?? 0) >= filters.minFoundedYear!);
  }
  if (filters.maxFoundedYear != null) {
    result = result.filter((d) => (d.foundedYear ?? 9999) <= filters.maxFoundedYear!);
  }
  if (filters.minHeadcountGrowth != null) {
    result = result.filter((d) => (d.headcountGrowth ?? 0) >= filters.minHeadcountGrowth!);
  }
  if (filters.companyEmailProvider) {
    result = result.filter((d) => d.companyEmailProvider === filters.companyEmailProvider);
  }
  if (filters.minIntentScore != null) {
    result = result.filter((d) => (d.intentScore ?? 0) >= filters.minIntentScore!);
  }

  // Hiring
  if (filters.currentlyHiring === true) {
    result = result.filter((d) => d.currentlyHiring === true);
  }
  if (filters.hiringDepartments?.length) {
    const selected = new Set(filters.hiringDepartments);
    result = result.filter(
      (d) => d.currentlyHiring === true && d.department && selected.has(d.department)
    );
  }

  // Company signals (OR)
  if (filters.companySignals?.length) {
    const selected = new Set(filters.companySignals);
    result = result.filter((d) => d.signals?.some((s) => selected.has(s.type)));
  }

  // Tech / intent (existing)
  if (filters.tech) {
    const v = filters.tech.toLowerCase();
    result = result.filter((d) =>
      d.techStack?.some((t) => t.technology.toLowerCase().includes(v))
    );
  }
  if (filters.signal) {
    const v = filters.signal.toLowerCase();
    result = result.filter((d) => d.signals?.some((s) => s.type.toLowerCase() === v));
  }

  result = postProcessSearchHits(result, filters);
  return result.slice(0, limit);
}
