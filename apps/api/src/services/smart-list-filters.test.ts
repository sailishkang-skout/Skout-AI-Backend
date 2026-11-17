import { describe, expect, it } from "vitest";
import type { ProspectFacets } from "@skout/opensearch";
import { countryLabel, resolveSmartListFilters } from "./smart-list-filters.js";

/** Values as they are actually stored on staging: two vocabularies side by side. */
const facets: ProspectFacets = {
  total: 6806,
  industry: [
    { value: "FinTech", count: 533 },
    { value: "Software & SaaS", count: 540 },
    { value: "Financial Services", count: 21 },
    { value: "Computer Software", count: 127 },
  ],
  country: [
    { value: "IN", count: 532 },
    { value: "India", count: 369 },
    { value: "US", count: 539 },
  ],
  seniority: [{ value: "vp", count: 764 }],
};

describe("resolveSmartListFilters", () => {
  it("turns what you entered on the form into values the index actually stores", () => {
    const out = resolveSmartListFilters(
      { industry: "Software & SaaS,Fintech", country: "India", seniority: "VP" },
      facets
    );
    expect(out.industries).toEqual(["Software & SaaS", "FinTech"]);
    expect(out.countries).toEqual(["IN", "India"]);
    expect(out.seniorities).toEqual(["vp"]);
    expect(out).not.toHaveProperty("industry");
    expect(out).not.toHaveProperty("country");
    expect(out).not.toHaveProperty("seniority");
  });

  it("matches countries by code, three-letter code, name or alias", () => {
    for (const typed of ["IN", "in", "IND", "india", " India "]) {
      expect(resolveSmartListFilters({ country: typed }, facets).countries).toEqual(["IN", "India"]);
    }
    expect(resolveSmartListFilters({ countries: ["United States of America"] }, facets).countries).toEqual(["US"]);
  });

  it("merges single and multi-value fields and removes duplicates", () => {
    const out = resolveSmartListFilters(
      { industry: "fintech", industries: ["FinTech", "Computer Software"], seniority: "vp", seniorities: ["VP", "director"] },
      facets
    );
    expect(out.industries).toEqual(["FinTech", "Computer Software"]);
    expect(out.seniorities).toEqual(["vp", "director"]);
  });

  it("keeps a value it can't place, so the user sees 0 matches rather than a silently widened list", () => {
    expect(resolveSmartListFilters({ industry: "Underwater Basket Weaving" }, facets).industries).toEqual([
      "Underwater Basket Weaving",
    ]);
  });

  it("drops seniority words that aren't a seniority instead of failing the whole list", () => {
    expect(resolveSmartListFilters({ seniorities: ["vp", "wizard"] }, facets).seniorities).toEqual(["vp"]);
  });

  it("still works without facets (OpenSearch facets unavailable): countries expand to code and name", () => {
    const out = resolveSmartListFilters({ country: "India", industry: "FinTech" }, null);
    expect(out.countries).toEqual(["IN", "IND", "India"]);
    expect(out.industries).toEqual(["FinTech"]);
  });

  it("leaves unrelated filters, including free-text query, untouched", () => {
    const out = resolveSmartListFilters({ query: "Razorpay", jobTitle: "Head of Sales", minEmployees: 10 }, facets);
    expect(out).toEqual({ query: "Razorpay", jobTitle: "Head of Sales", minEmployees: 10 });
  });
});

describe("countryLabel", () => {
  it("shows a readable name for stored country codes", () => {
    expect(countryLabel("IN")).toBe("India");
    expect(countryLabel("India")).toBe("India");
    expect(countryLabel("Atlantis")).toBe("Atlantis");
  });
});
