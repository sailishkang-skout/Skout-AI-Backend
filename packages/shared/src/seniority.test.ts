import { describe, expect, it } from "vitest";
import { normalizeSeniority, searchFiltersSchema } from "./schemas.js";

describe("normalizeSeniority", () => {
  it("maps the stored values to themselves", () => {
    for (const v of ["founder", "co_founder", "ceo", "c_level", "vp", "director", "head", "manager", "individual_contributor", "unknown"]) {
      expect(normalizeSeniority(v)).toBe(v);
    }
  });

  it("accepts the labels people type, in any case", () => {
    expect(normalizeSeniority("VP")).toBe("vp");
    expect(normalizeSeniority(" Vice President ")).toBe("vp");
    expect(normalizeSeniority("SVP")).toBe("vp");
    expect(normalizeSeniority("C-Level")).toBe("c_level");
    expect(normalizeSeniority("C-Suite")).toBe("c_level");
    expect(normalizeSeniority("CXO")).toBe("c_level");
    expect(normalizeSeniority("Co-Founder")).toBe("co_founder");
    expect(normalizeSeniority("Cofounder")).toBe("co_founder");
    expect(normalizeSeniority("Head of")).toBe("head");
    expect(normalizeSeniority("Individual Contributor")).toBe("individual_contributor");
    expect(normalizeSeniority("IC")).toBe("individual_contributor");
    expect(normalizeSeniority("CEO")).toBe("ceo");
    expect(normalizeSeniority("Director")).toBe("director");
  });

  it("treats blank input as not set", () => {
    expect(normalizeSeniority("")).toBeUndefined();
    expect(normalizeSeniority("   ")).toBeUndefined();
  });

  it("leaves unknown words untouched so validation still rejects them", () => {
    expect(normalizeSeniority("Wizard")).toBe("wizard");
  });
});

describe("searchFiltersSchema seniority", () => {
  it("accepts 'VP' and stores 'vp' (the smart-list 422)", () => {
    expect(searchFiltersSchema.parse({ seniority: "VP" }).seniority).toBe("vp");
  });

  it("treats an empty seniority as not set", () => {
    expect(searchFiltersSchema.parse({ seniority: "" }).seniority).toBeUndefined();
  });

  it("still rejects values that aren't a seniority", () => {
    expect(searchFiltersSchema.safeParse({ seniority: "Wizard" }).success).toBe(false);
  });
});
