import { describe, expect, it } from "vitest";
import { onboardingSchema } from "./icp.routes.js";

describe("onboardingSchema — 8.1 fields", () => {
  it("keeps company.hqCountry and company.locale instead of silently stripping them", () => {
    const parsed = onboardingSchema.parse({
      company: { name: "Acme", hqCountry: "United States", locale: "en-US" },
    });
    expect(parsed.company?.hqCountry).toBe("United States");
    expect(parsed.company?.locale).toBe("en-US");
  });

  it("accepts businessModel and dataPolicy", () => {
    const parsed = onboardingSchema.parse({
      businessModel: "b2b",
      dataPolicy: "strict",
    });
    expect(parsed.businessModel).toBe("b2b");
    expect(parsed.dataPolicy).toBe("strict");
  });

  it("rejects an invalid businessModel/dataPolicy value", () => {
    expect(() => onboardingSchema.parse({ businessModel: "nonprofit" })).toThrow();
    expect(() => onboardingSchema.parse({ dataPolicy: "loose" })).toThrow();
  });

  it("still works with none of the new fields set (all optional)", () => {
    const parsed = onboardingSchema.parse({ goals: ["Generate leads"] });
    expect(parsed.businessModel).toBeUndefined();
    expect(parsed.dataPolicy).toBeUndefined();
    expect(parsed.company).toBeUndefined();
  });
});
