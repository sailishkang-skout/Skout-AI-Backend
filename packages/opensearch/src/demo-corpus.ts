import { createHash } from "node:crypto";
import type { ProspectDocument, SearchFilters } from "./index.js";

const INDUSTRIES = ["Software", "FinTech", "Healthcare", "Retail", "Manufacturing"];
const COUNTRIES = ["US", "DE", "GB", "FR", "CA"];
const SENIORITIES = ["vp", "director", "manager", "c_suite", "unknown"];

/** Synthetic corpus for local dev when OpenSearch is empty or unreachable. */
export function buildDemoCorpus(count = 100): ProspectDocument[] {
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, i) => ({
    prospectId: createHash("sha256").update(`demo-prospect-${i}`).digest("hex"),
    companyId: createHash("sha256").update(`demo-company-${i % 20}`).digest("hex"),
    fullName: `Demo Prospect ${i + 1}`,
    title: i % 2 === 0 ? "VP Sales" : "Director of Marketing",
    seniority: SENIORITIES[i % SENIORITIES.length],
    companyDomain: `example${(i % 10) + 1}.com`,
    companyName: `Example Corp ${(i % 10) + 1}`,
    industry: INDUSTRIES[i % INDUSTRIES.length],
    country: COUNTRIES[i % COUNTRIES.length],
    employeeCount: 50 + i * 25,
    techStack:
      i % 3 === 0
        ? [{ category: "CRM", technology: "HubSpot" }]
        : i % 3 === 1
          ? [{ category: "CRM", technology: "Salesforce" }]
          : [],
    signals: i % 4 === 0 ? [{ type: "hiring", observedAt: now, detail: "SDR roles posted" }] : [],
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
  if (filters.industry) {
    const v = filters.industry.toLowerCase();
    result = result.filter((d) => d.industry?.toLowerCase() === v);
  }
  if (filters.country) {
    const v = filters.country.toLowerCase();
    result = result.filter((d) => d.country?.toLowerCase() === v);
  }
  if (filters.seniority) {
    const v = filters.seniority.toLowerCase();
    result = result.filter((d) => d.seniority?.toLowerCase() === v);
  }
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
  if (filters.minEmployees != null) {
    result = result.filter((d) => (d.employeeCount ?? 0) >= filters.minEmployees!);
  }
  if (filters.maxEmployees != null) {
    result = result.filter((d) => (d.employeeCount ?? 0) <= filters.maxEmployees!);
  }

  return result.slice(0, limit);
}
