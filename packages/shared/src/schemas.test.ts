import { describe, it, expect } from "vitest";
import { searchFiltersSchema, searchProspectsRequestSchema } from "./schemas.js";

describe("searchFiltersSchema", () => {
  describe("valid inputs", () => {
    it("parses an empty object", () => {
      expect(searchFiltersSchema.parse({})).toEqual({});
    });

    it("parses a full valid filter object", () => {
      const result = searchFiltersSchema.parse({
        fullName: "Sarah Johnson",
        jobTitle: "VP Sales",
        department: "Sales",
        seniority: "vp",
        jobFunction: "AE",
        emailAvailable: true,
        phoneAvailable: false,
        linkedInAvailable: true,
        companyName: "Salesforce",
        industry: "Software & SaaS",
        subIndustry: "CRM",
        country: "US",
        state: "CA",
        city: "San Francisco",
        minEmployees: 50,
        maxEmployees: 5000,
        companyStage: "series_b",
        lastFundingRound: "series_b",
        minRevenue: 10_000_000,
        maxRevenue: 100_000_000,
        currentlyHiring: true,
        hiringDepartments: ["Engineering", "Sales"],
        companySignals: ["recent_funding"],
        minYearsAtCompany: 1,
        minYearsInRole: 0,
        previousCompany: "HubSpot",
        contactSignals: ["recently_promoted"],
        tech: "Salesforce",
        signal: "promotion",
      });

      expect(result.fullName).toBe("Sarah Johnson");
      expect(result.seniority).toBe("vp");
      expect(result.emailAvailable).toBe(true);
      expect(result.minEmployees).toBe(50);
      expect(result.contactSignals).toEqual(["recently_promoted"]);
    });
  });

  describe("boolean coercion", () => {
    it('coerces string "true" to true for emailAvailable', () => {
      expect(searchFiltersSchema.parse({ emailAvailable: "true" }).emailAvailable).toBe(true);
    });

    it('coerces string "false" to true for emailAvailable (z.coerce.boolean uses Boolean())', () => {
      // Boolean("false") === true — non-empty strings are always truthy
      expect(searchFiltersSchema.parse({ emailAvailable: "false" }).emailAvailable).toBe(true);
    });

    it('coerces string "1" to true for emailAvailable', () => {
      expect(searchFiltersSchema.parse({ emailAvailable: "1" }).emailAvailable).toBe(true);
    });

    it('coerces string "0" to true for emailAvailable (non-empty string is truthy)', () => {
      // Boolean("0") === true — only the number 0 (not the string "0") is falsy
      expect(searchFiltersSchema.parse({ emailAvailable: "0" }).emailAvailable).toBe(true);
    });

    it("coerces string booleans for phoneAvailable", () => {
      expect(searchFiltersSchema.parse({ phoneAvailable: "true" }).phoneAvailable).toBe(true);
    });

    it("coerces string booleans for linkedInAvailable", () => {
      expect(searchFiltersSchema.parse({ linkedInAvailable: "true" }).linkedInAvailable).toBe(true);
    });

    it("coerces string booleans for currentlyHiring", () => {
      expect(searchFiltersSchema.parse({ currentlyHiring: "true" }).currentlyHiring).toBe(true);
    });
  });

  describe("seniority enum", () => {
    const validValues = [
      "founder",
      "co_founder",
      "ceo",
      "c_level",
      "vp",
      "director",
      "head",
      "manager",
      "individual_contributor",
      "unknown",
    ] as const;

    for (const value of validValues) {
      it(`accepts seniority "${value}"`, () => {
        expect(() => searchFiltersSchema.parse({ seniority: value })).not.toThrow();
      });
    }

    it("rejects invalid seniority value", () => {
      expect(() => searchFiltersSchema.parse({ seniority: "intern" })).toThrow();
    });

    it("rejects numeric seniority value", () => {
      expect(() => searchFiltersSchema.parse({ seniority: 1 })).toThrow();
    });
  });

  describe("number constraints", () => {
    it("rejects negative minEmployees", () => {
      expect(() => searchFiltersSchema.parse({ minEmployees: -1 })).toThrow();
    });

    it("rejects negative maxEmployees", () => {
      expect(() => searchFiltersSchema.parse({ maxEmployees: -5 })).toThrow();
    });

    it("accepts zero for minEmployees", () => {
      expect(() => searchFiltersSchema.parse({ minEmployees: 0 })).not.toThrow();
    });

    it("rejects negative minRevenue", () => {
      expect(() => searchFiltersSchema.parse({ minRevenue: -1000 })).toThrow();
    });

    it("accepts zero for minRevenue", () => {
      expect(() => searchFiltersSchema.parse({ minRevenue: 0 })).not.toThrow();
    });

    it("rejects non-integer minEmployees", () => {
      expect(() => searchFiltersSchema.parse({ minEmployees: 10.5 })).toThrow();
    });

    it("rejects negative minYearsAtCompany", () => {
      expect(() => searchFiltersSchema.parse({ minYearsAtCompany: -1 })).toThrow();
    });
  });

  describe("array fields", () => {
    it("parses contactSignals as string array", () => {
      const result = searchFiltersSchema.parse({
        contactSignals: ["recently_promoted", "changed_jobs"],
      });
      expect(result.contactSignals).toEqual(["recently_promoted", "changed_jobs"]);
    });

    it("parses hiringDepartments as string array", () => {
      const result = searchFiltersSchema.parse({ hiringDepartments: ["Engineering"] });
      expect(result.hiringDepartments).toEqual(["Engineering"]);
    });

    it("parses companySignals as string array", () => {
      const result = searchFiltersSchema.parse({ companySignals: ["recent_funding"] });
      expect(result.companySignals).toEqual(["recent_funding"]);
    });

    it("accepts empty arrays", () => {
      expect(() =>
        searchFiltersSchema.parse({ contactSignals: [], hiringDepartments: [] })
      ).not.toThrow();
    });
  });

  describe("optional fields", () => {
    it("leaves unset optional fields as undefined", () => {
      const result = searchFiltersSchema.parse({ country: "US" });
      expect(result.industry).toBeUndefined();
      expect(result.seniority).toBeUndefined();
      expect(result.emailAvailable).toBeUndefined();
    });
  });
});

describe("searchProspectsRequestSchema", () => {
  it("defaults page to 1", () => {
    const result = searchProspectsRequestSchema.parse({});
    expect(result.page).toBe(1);
  });

  it("defaults pageSize to 25", () => {
    const result = searchProspectsRequestSchema.parse({});
    expect(result.pageSize).toBe(25);
  });

  it("rejects page below 1", () => {
    expect(() => searchProspectsRequestSchema.parse({ page: 0 })).toThrow();
  });

  it("rejects pageSize above 100", () => {
    expect(() => searchProspectsRequestSchema.parse({ pageSize: 101 })).toThrow();
  });

  it("accepts pageSize of 100", () => {
    expect(() => searchProspectsRequestSchema.parse({ pageSize: 100 })).not.toThrow();
  });

  it("parses with nested filters", () => {
    const result = searchProspectsRequestSchema.parse({
      query: "VP Sales",
      filters: { country: "US", seniority: "vp" },
      page: 2,
      pageSize: 10,
    });
    expect(result.query).toBe("VP Sales");
    expect(result.filters?.country).toBe("US");
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(10);
  });

  it("parses without filters", () => {
    const result = searchProspectsRequestSchema.parse({ query: "CRM" });
    expect(result.filters).toBeUndefined();
  });
});
