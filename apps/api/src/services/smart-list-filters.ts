/**
 * Turns smart-list filters as people enter them into values the search index actually stores.
 *
 * Search filters are exact, case-sensitive matches, and the index holds more than one vocabulary
 * (seeded prospects store country "IN" and industry "FinTech"; captured ones store "India" and
 * LinkedIn industries). So "Fintech" or "India" or "Software,Fintech" matched nothing. Filters are
 * saved as entered and resolved here every time the list runs, so they keep working as the data
 * changes.
 */
import { normalizeSeniority, seniorityEnum } from "@skout/shared";
import type { FacetValue, ProspectFacets, SearchFilters } from "@skout/opensearch";
import { COUNTRY_NAMES } from "./smart-list-countries.js";

const VALID_SENIORITIES = new Set<string>(seniorityEnum.options.filter((v) => v !== "unknown"));

/** "a, b; c" → ["a","b","c"]; arrays pass through; empty pieces removed. */
function splitValues(...inputs: (string | string[] | undefined)[]): string[] {
  const out: string[] = [];
  for (const input of inputs) {
    if (!input) continue;
    for (const raw of Array.isArray(input) ? input : [input]) {
      for (const piece of String(raw).split(/[,;]/)) {
        const v = piece.trim();
        if (v) out.push(v);
      }
    }
  }
  return out;
}

const unique = (values: string[]) => [...new Set(values)];

/** Case-insensitive lookup of a typed value among stored values. */
function storedMatch(value: string, stored: FacetValue[]): string | undefined {
  const v = value.toLowerCase();
  return stored.find((s) => s.value.toLowerCase() === v)?.value;
}

const countryByKey = new Map<string, readonly string[]>();
for (const row of COUNTRY_NAMES) for (const key of row) countryByKey.set(key.toLowerCase(), row);

/** Readable name for a stored country value ("IN" → "India"); unknown values are returned as is. */
export function countryLabel(value: string): string {
  return countryByKey.get(value.toLowerCase())?.[2] ?? value;
}

function resolveCountries(values: string[], facets: ProspectFacets | null): string[] {
  const out: string[] = [];
  for (const value of values) {
    const variants = countryByKey.get(value.toLowerCase()) ?? [value];
    if (facets) {
      // Every stored spelling of this country that exists in the index ("IN" and "India").
      const stored = variants.map((v) => storedMatch(v, facets.country)).filter((v): v is string => Boolean(v));
      out.push(...(stored.length ? stored : [value]));
    } else {
      out.push(...variants.slice(0, 3));
    }
  }
  return unique(out);
}

function resolveIndustries(values: string[], facets: ProspectFacets | null): string[] {
  return unique(values.map((v) => (facets ? storedMatch(v, facets.industry) ?? v : v)));
}

function resolveSeniorities(values: string[]): string[] {
  return unique(
    values
      .map((v) => normalizeSeniority(v))
      .filter((v): v is string => typeof v === "string" && VALID_SENIORITIES.has(v))
  );
}

export function resolveSmartListFilters(filters: SearchFilters, facets: ProspectFacets | null): SearchFilters {
  const { industry, industries, country, countries, seniority, seniorities, ...rest } = filters;
  const out: SearchFilters = { ...rest };

  const industryValues = splitValues(industry, industries);
  if (industryValues.length) out.industries = resolveIndustries(industryValues, facets);

  const countryValues = splitValues(country, countries);
  if (countryValues.length) out.countries = resolveCountries(countryValues, facets);

  const seniorityValues = splitValues(seniority, seniorities);
  if (seniorityValues.length) {
    const resolved = resolveSeniorities(seniorityValues);
    if (resolved.length) out.seniorities = resolved;
  }
  return out;
}
