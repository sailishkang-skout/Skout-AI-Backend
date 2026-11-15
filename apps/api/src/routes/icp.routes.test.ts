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

describe("onboarding completion follows the persona's questions", () => {
  const done = new Date().toISOString();
  const company = { name: "Acme", industry: "SaaS", size: "11-50" };
  it("an Executive Viewer finishes with company and goals only", async () => {
    const { assertValidOnboardingCompletion } = await import("./icp.routes.js");
    expect(() => assertValidOnboardingCompletion(onboardingSchema.parse({ persona: "executive_viewer", company: { name: "Acme" }, goals: ["reporting"], completedAt: done }))).not.toThrow();
  });
  it("a BDR/SDR or AE finishes without market (the wizard does not ask it)", async () => {
    const { assertValidOnboardingCompletion } = await import("./icp.routes.js");
    const base = { company, goals: ["pipeline"], icp: { industries: ["SaaS"] }, people: { seniorities: ["VP"] }, leadVolume: "1000/month", completedAt: done };
    expect(() => assertValidOnboardingCompletion(onboardingSchema.parse({ ...base, persona: "bdr_sdr" }))).not.toThrow();
    expect(() => assertValidOnboardingCompletion(onboardingSchema.parse({ ...base, persona: "ae" }))).not.toThrow();
    // An admin goes through the full flow, so market is still required.
    expect(() => assertValidOnboardingCompletion(onboardingSchema.parse({ ...base, persona: "admin" }))).toThrow(/requires/);
  });
});
