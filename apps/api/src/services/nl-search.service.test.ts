import { describe, expect, it, vi } from "vitest";
import { mergeTranslatedFilters, translateNaturalLanguageQuery } from "./nl-search.service.js";

describe("translateNaturalLanguageQuery (heuristic path, no API key)", () => {
  it("returns empty filters for an empty query", async () => {
    const result = await translateNaturalLanguageQuery("   ");
    expect(result).toEqual({ filters: {}, method: "heuristic" });
  });

  it("extracts seniority, department, employee count, country, and industry", async () => {
    const result = await translateNaturalLanguageQuery(
      "VP of Engineering at SaaS companies in Germany with 50+ employees"
    );
    expect(result.method).toBe("heuristic");
    expect(result.filters.seniority).toBe("vp");
    expect(result.filters.department).toBe("Engineering");
    expect(result.filters.minEmployees).toBe(50);
    expect(result.filters.country).toBe("Germany");
    expect(result.filters.industry).toBe("SaaS");
  });

  it("extracts currentlyHiring from hiring-related phrasing", async () => {
    const result = await translateNaturalLanguageQuery("Companies that are hiring right now");
    expect(result.filters.currentlyHiring).toBe(true);
  });

  it("extracts company signals from recent-funding phrasing", async () => {
    const result = await translateNaturalLanguageQuery("Startups that just raised funding recently");
    expect(result.filters.companySignals).toContain("recent_funding");
  });

  it("extracts contact signals from recently-promoted phrasing", async () => {
    const result = await translateNaturalLanguageQuery("People who were recently promoted");
    expect(result.filters.contactSignals).toContain("recently_promoted");
  });

  it("extracts an employee range when both bounds are given", async () => {
    const result = await translateNaturalLanguageQuery("Companies with 50 to 200 employees");
    expect(result.filters.minEmployees).toBe(50);
    expect(result.filters.maxEmployees).toBe(200);
  });

  it("leaves fields unset when nothing in the query matches", async () => {
    const result = await translateNaturalLanguageQuery("asdkjfh qwerty zzz");
    expect(result.filters).toEqual({});
  });
});

describe("translateNaturalLanguageQuery (LLM path)", () => {
  it("falls back to the heuristic when the LLM call throws", async () => {
    vi.doMock("openai", () => ({
      default: class {
        chat = { completions: { create: vi.fn().mockRejectedValue(new Error("network down")) } };
      },
    }));
    vi.resetModules();
    const { translateNaturalLanguageQuery: translateWithMock } = await import("./nl-search.service.js");

    const result = await translateWithMock("VP of Sales in Germany", { openrouterApiKey: "test-key" });
    expect(result.method).toBe("heuristic");
    expect(result.filters.seniority).toBe("vp");

    vi.doUnmock("openai");
    vi.resetModules();
  });

  it("uses the LLM's sanitized response when the call succeeds", async () => {
    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      seniority: "director",
                      department: "Sales",
                      country: "France",
                      minEmployees: 100,
                      currentlyHiring: true,
                      companyStage: "not_a_real_stage",
                    }),
                  },
                },
              ],
            }),
          },
        };
      },
    }));
    vi.resetModules();
    const { translateNaturalLanguageQuery: translateWithMock } = await import("./nl-search.service.js");

    const result = await translateWithMock("Directors of sales in France", { openrouterApiKey: "test-key" });
    expect(result.method).toBe("llm");
    expect(result.filters.seniority).toBe("director");
    expect(result.filters.department).toBe("Sales");
    expect(result.filters.country).toBe("France");
    expect(result.filters.minEmployees).toBe(100);
    expect(result.filters.currentlyHiring).toBe(true);
    // Not a real enum value — must be dropped, never passed through unsanitized.
    expect(result.filters.companyStage).toBeUndefined();

    vi.doUnmock("openai");
    vi.resetModules();
  });
});

describe("mergeTranslatedFilters", () => {
  it("fills in fields the caller didn't already set", () => {
    const merged = mergeTranslatedFilters({ industry: "Fintech" }, { seniority: "vp", country: "Germany" });
    expect(merged).toEqual({ industry: "Fintech", seniority: "vp", country: "Germany" });
  });

  it("never overrides a filter the caller already set explicitly", () => {
    const merged = mergeTranslatedFilters({ country: "United States" }, { country: "Germany" });
    expect(merged.country).toBe("United States");
  });
});
