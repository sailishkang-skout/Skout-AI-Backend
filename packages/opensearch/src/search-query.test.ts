import { describe, it, expect } from "vitest";
import { aggregateDemoCorpus, buildSearchQuery } from "./index.js";
import type { ProspectDocument } from "./index.js";

describe("buildSearchQuery", () => {
  describe("empty filters", () => {
    it("returns match_all when no filters provided", () => {
      const q = buildSearchQuery({});
      expect(q.query).toEqual({ bool: { must: [{ match_all: {} }] } });
    });

    it("defaults to page 1 and size 25", () => {
      const q = buildSearchQuery({});
      expect(q.from).toBe(0);
      expect(q.size).toBe(25);
    });

    it("sorts by updatedAt desc", () => {
      const q = buildSearchQuery({});
      expect(q.sort).toEqual([{ updatedAt: "desc" }]);
    });
  });

  describe("pagination", () => {
    it("calculates correct from for page 2", () => {
      const q = buildSearchQuery({}, 2, 25);
      expect(q.from).toBe(25);
    });

    it("calculates correct from for page 3 with custom page size", () => {
      const q = buildSearchQuery({}, 3, 10);
      expect(q.from).toBe(20);
      expect(q.size).toBe(10);
    });
  });

  describe("free-text query", () => {
    it("adds multi_match in must clause for non-empty query", () => {
      const q = buildSearchQuery({ query: "CRM software" });
      const bool = q.query.bool as { must?: object[] };
      expect(bool.must).toContainEqual(
        expect.objectContaining({ multi_match: expect.objectContaining({ query: "CRM software" }) })
      );
    });

    it("ignores whitespace-only query", () => {
      const q = buildSearchQuery({ query: "   " });
      expect(q.query).toEqual({ bool: { must: [{ match_all: {} }] } });
    });
  });

  describe("contact filters", () => {
    it("adds match_phrase_prefix for fullName", () => {
      const q = buildSearchQuery({ fullName: "Sarah" });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ match_phrase_prefix: { fullName: "Sarah" } });
    });

    it("trims whitespace from fullName", () => {
      const q = buildSearchQuery({ fullName: "  Sarah  " });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ match_phrase_prefix: { fullName: "Sarah" } });
    });

    it("ignores whitespace-only fullName", () => {
      const q = buildSearchQuery({ fullName: "   " });
      expect(q.query).toEqual({ bool: { must: [{ match_all: {} }] } });
    });

    it("adds match filter for jobTitle", () => {
      const q = buildSearchQuery({ jobTitle: "VP Sales" });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ match: { title: "VP Sales" } });
    });

    it("adds term filter for department", () => {
      const q = buildSearchQuery({ department: "Sales" });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ term: { department: "Sales" } });
    });

    it("adds term filter for seniority", () => {
      const q = buildSearchQuery({ seniority: "vp" });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ term: { seniority: "vp" } });
    });

    it("adds term filter for jobFunction", () => {
      const q = buildSearchQuery({ jobFunction: "AE" });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ term: { jobFunction: "AE" } });
    });

    it("adds exists filter when emailAvailable is true", () => {
      const q = buildSearchQuery({ emailAvailable: true });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ exists: { field: "email" } });
    });

    it("does NOT add filter when emailAvailable is false", () => {
      const q = buildSearchQuery({ emailAvailable: false });
      expect(q.query).toEqual({ bool: { must: [{ match_all: {} }] } });
    });

    it("adds exists filter for phoneAvailable", () => {
      const q = buildSearchQuery({ phoneAvailable: true });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ exists: { field: "phone" } });
    });

    it("adds exists filter for linkedInAvailable", () => {
      const q = buildSearchQuery({ linkedInAvailable: true });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ exists: { field: "linkedinUrl" } });
    });
  });

  describe("experience filters", () => {
    it("adds range filter for minYearsAtCompany", () => {
      const q = buildSearchQuery({ minYearsAtCompany: 2 });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ range: { yearsAtCompany: { gte: 2 } } });
    });

    it("adds range filter for minYearsInRole", () => {
      const q = buildSearchQuery({ minYearsInRole: 1 });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ range: { yearsInRole: { gte: 1 } } });
    });

    it("adds match filter for previousCompany", () => {
      const q = buildSearchQuery({ previousCompany: "Salesforce" });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ match: { previousCompany: "Salesforce" } });
    });
  });

  describe("contact signals", () => {
    it("adds nested terms filter for single signal", () => {
      const q = buildSearchQuery({ contactSignals: ["recently_promoted"] });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({
        nested: {
          path: "signals",
          query: { terms: { "signals.type": ["recently_promoted"] } },
        },
      });
    });

    it("adds nested terms filter for multiple signals (OR logic)", () => {
      const q = buildSearchQuery({ contactSignals: ["recently_promoted", "changed_jobs"] });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({
        nested: {
          path: "signals",
          query: { terms: { "signals.type": ["recently_promoted", "changed_jobs"] } },
        },
      });
    });

    it("does not add filter for empty contactSignals array", () => {
      const q = buildSearchQuery({ contactSignals: [] });
      expect(q.query).toEqual({ bool: { must: [{ match_all: {} }] } });
    });
  });

  describe("company basic filters", () => {
    it("adds match filter for companyName", () => {
      const q = buildSearchQuery({ companyName: "Salesforce" });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ match: { companyName: "Salesforce" } });
    });

    it("adds term filter for industry", () => {
      const q = buildSearchQuery({ industry: "FinTech" });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ term: { industry: "FinTech" } });
    });

    it("adds term filter for subIndustry", () => {
      const q = buildSearchQuery({ subIndustry: "Payments" });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ term: { subIndustry: "Payments" } });
    });

    it("adds term filter for country", () => {
      const q = buildSearchQuery({ country: "US" });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ term: { country: "US" } });
    });

    it("adds term filter for state", () => {
      const q = buildSearchQuery({ state: "CA" });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ term: { state: "CA" } });
    });

    it("adds match filter for city", () => {
      const q = buildSearchQuery({ city: "San Francisco" });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ match: { city: "San Francisco" } });
    });

    it("adds range filter for both min and max employees", () => {
      const q = buildSearchQuery({ minEmployees: 50, maxEmployees: 200 });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({
        range: { employeeCount: { gte: 50, lte: 200 } },
      });
    });

    it("adds range filter for min employees only", () => {
      const q = buildSearchQuery({ minEmployees: 100 });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ range: { employeeCount: { gte: 100 } } });
    });

    it("adds range filter for max employees only", () => {
      const q = buildSearchQuery({ maxEmployees: 500 });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ range: { employeeCount: { lte: 500 } } });
    });
  });

  describe("company stage & funding filters", () => {
    it("adds term filter for companyStage", () => {
      const q = buildSearchQuery({ companyStage: "series_b" });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ term: { companyStage: "series_b" } });
    });

    it("adds term filter for lastFundingRound", () => {
      const q = buildSearchQuery({ lastFundingRound: "series_a" });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ term: { lastFundingRound: "series_a" } });
    });

    it("adds range filter for revenue", () => {
      const q = buildSearchQuery({ minRevenue: 1_000_000, maxRevenue: 10_000_000 });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({
        range: { annualRevenue: { gte: 1_000_000, lte: 10_000_000 } },
      });
    });
  });

  describe("hiring filters", () => {
    it("adds term filter for currentlyHiring=true", () => {
      const q = buildSearchQuery({ currentlyHiring: true });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ term: { currentlyHiring: true } });
    });

    it("does NOT add filter when currentlyHiring is false", () => {
      const q = buildSearchQuery({ currentlyHiring: false });
      expect(q.query).toEqual({ bool: { must: [{ match_all: {} }] } });
    });

    it("adds terms filter for hiringDepartments", () => {
      const q = buildSearchQuery({ hiringDepartments: ["Engineering", "Sales"] });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({
        terms: { hiringDepartments: ["Engineering", "Sales"] },
      });
    });
  });

  describe("company signals", () => {
    it("adds nested terms filter for companySignals", () => {
      const q = buildSearchQuery({ companySignals: ["recent_funding", "leadership_change"] });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({
        nested: {
          path: "signals",
          query: { terms: { "signals.type": ["recent_funding", "leadership_change"] } },
        },
      });
    });
  });

  describe("combined filters", () => {
    it("applies all filters together", () => {
      const q = buildSearchQuery({
        fullName: "Alex",
        seniority: "director",
        country: "US",
        minEmployees: 50,
        maxEmployees: 500,
        emailAvailable: true,
      });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toHaveLength(5);
    });

    it("puts free-text query in must and other filters in filter", () => {
      const q = buildSearchQuery({ query: "CRM", country: "US" });
      const bool = q.query.bool as { must?: object[]; filter?: object[] };
      expect(bool.must).toHaveLength(1);
      expect(bool.filter).toHaveLength(1);
    });
  });

  describe("R12.1 multi-select filters (industries/countries/seniorities)", () => {
    it("adds a terms clause per non-empty plural filter", () => {
      const q = buildSearchQuery({
        industries: ["SaaS", "Fintech"],
        countries: ["US", "CA"],
        seniorities: ["director", "vp"],
      });
      const bool = q.query.bool as { filter?: object[] };
      expect(bool.filter).toContainEqual({ terms: { industry: ["SaaS", "Fintech"] } });
      expect(bool.filter).toContainEqual({ terms: { country: ["US", "CA"] } });
      expect(bool.filter).toContainEqual({ terms: { seniority: ["director", "vp"] } });
    });

    it("omits the terms clause for an empty array", () => {
      const q = buildSearchQuery({ industries: [] });
      expect(q.query.bool).toEqual({ must: [{ match_all: {} }] });
    });
  });
});

describe("aggregateDemoCorpus", () => {
  function doc(overrides: Partial<ProspectDocument>): ProspectDocument {
    return {
      prospectId: "p1",
      companyId: "c1",
      companyDomain: "acme.com",
      ...overrides,
    } as ProspectDocument;
  }

  it("counts total and buckets industry/size/geo for matched docs", () => {
    const docs = [
      doc({ industry: "SaaS", employeeBucket: "11-50", country: "US" }),
      doc({ industry: "SaaS", employeeBucket: "51-200", country: "US" }),
      doc({ industry: "Fintech", employeeBucket: "11-50", country: "CA" }),
    ];

    const result = aggregateDemoCorpus(docs, {});

    expect(result.total).toBe(3);
    expect(result.segments).toContainEqual({ dimension: "industry", value: "SaaS", count: 2 });
    expect(result.segments).toContainEqual({ dimension: "industry", value: "Fintech", count: 1 });
    expect(result.segments).toContainEqual({ dimension: "geo", value: "US", count: 2 });
    expect(result.segments).toContainEqual({ dimension: "size", value: "11-50", count: 2 });
  });

  it("respects the same filters as filterDemoCorpus, including multi-select", () => {
    const docs = [
      doc({ industry: "SaaS", country: "US" }),
      doc({ industry: "Fintech", country: "US" }),
    ];

    const result = aggregateDemoCorpus(docs, { industries: ["SaaS"] });

    expect(result.total).toBe(1);
    expect(result.segments).toContainEqual({ dimension: "industry", value: "SaaS", count: 1 });
  });

  it("buckets missing fields as unknown", () => {
    const result = aggregateDemoCorpus([doc({})], {});
    expect(result.segments).toContainEqual({ dimension: "industry", value: "unknown", count: 1 });
  });
});
