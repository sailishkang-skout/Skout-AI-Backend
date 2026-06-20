import { createHash } from "node:crypto";
import type { ProspectDocument, SearchFilters } from "./index.js";

const INDUSTRIES = ["Software & SaaS", "FinTech", "Healthcare", "Retail & E-Commerce", "Manufacturing"];
const COUNTRIES = ["US", "DE", "GB", "FR", "CA"];
const CITIES = ["San Francisco", "New York", "London", "Berlin", "Toronto"];
const STATES = ["CA", "NY", "TX", "WA", "ON"];
const STAGES = ["seed", "series_a", "series_b", "bootstrapped", "public"];
const SENIORITIES = ["vp", "director", "manager", "c_level", "founder", "head", "individual_contributor"];
const DEPARTMENTS = ["Sales", "Marketing", "Engineering", "Product", "Operations", "Finance"];
const JOB_FUNCTIONS = ["AE", "SDR", "Demand Generation", "RevOps", "Growth", "Recruiting"];

/** Synthetic corpus for local dev when OpenSearch is empty or unreachable. */
export function buildDemoCorpus(count = 100): ProspectDocument[] {
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, i) => ({
    prospectId: createHash("sha256").update(`demo-prospect-${i}`).digest("hex"),
    companyId: createHash("sha256").update(`demo-company-${i % 20}`).digest("hex"),
    fullName: `Demo Prospect ${i + 1}`,
    title: i % 2 === 0 ? "VP Sales" : "Director of Marketing",
    seniority: SENIORITIES[i % SENIORITIES.length],
    department: DEPARTMENTS[i % DEPARTMENTS.length],
    jobFunction: JOB_FUNCTIONS[i % JOB_FUNCTIONS.length],
    email: i % 3 !== 0 ? `prospect${i}@example${(i % 10) + 1}.com` : undefined,
    phone: i % 4 === 0 ? `+1-555-${String(i).padStart(4, "0")}` : undefined,
    linkedinUrl: i % 2 === 0 ? `https://linkedin.com/in/demo-prospect-${i}` : undefined,
    companyDomain: `example${(i % 10) + 1}.com`,
    companyName: `Example Corp ${(i % 10) + 1}`,
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

  // Hiring
  if (filters.currentlyHiring === true) {
    result = result.filter((d) => d.currentlyHiring === true);
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

  return result.slice(0, limit);
}
