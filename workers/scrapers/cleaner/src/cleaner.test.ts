import { describe, expect, it } from "vitest";
import { detectTechnologies } from "./wappalyzer.js";
import { cleanCompanies } from "./company-cleaner.js";

describe("wappalyzer", () => {
  it("detects HubSpot from HTML fingerprints", () => {
    const html = '<script src="https://js.hs-scripts.com/123.js"></script>';
    const tech = detectTechnologies(html);
    expect(tech.some((t) => t.technology === "HubSpot")).toBe(true);
  });

  it("skips first-party Stripe on stripe.com", () => {
    const html = '<script src="https://js.stripe.com/v3/"></script>';
    const tech = detectTechnologies(html, { domain: "stripe.com" });
    expect(tech.some((t) => t.technology === "Stripe")).toBe(false);
  });
});

describe("company-cleaner", () => {
  it("cleans company-web raw records", () => {
    const result = cleanCompanies([
      {
        source: "company-web",
        scrapedAt: new Date().toISOString(),
        payload: { domain: "acme.com", companyName: "Acme", description: "B2B SaaS" },
      },
    ]);
    expect(result.clean.length).toBe(1);
    expect(result.clean[0].domain).toBe("acme.com");
  });
});
