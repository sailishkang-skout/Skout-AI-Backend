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

  it("§8.5 SS-07 — derives leadership_change and news_mention signals from raw payload fields", () => {
    const result = cleanCompanies([
      {
        source: "company-web",
        scrapedAt: new Date().toISOString(),
        payload: {
          domain: "acme.com",
          companyName: "Acme",
          description: "B2B SaaS",
          leadershipChange: {
            changeType: "hire",
            role: "CEO",
            personName: "Jane Doe",
            effectiveDate: "2026-08-01T00:00:00.000Z",
          },
          newsMentions: [
            { headline: "Acme raises Series B", publishedAt: "2026-07-01T00:00:00.000Z", source: "techcrunch" },
          ],
        },
      },
    ]);

    expect(result.quarantined).toHaveLength(0);
    const company = result.clean[0]!;
    expect(company.leadershipChange).toMatchObject({ role: "CEO", personName: "Jane Doe" });
    expect(company.newsMentions).toHaveLength(1);
    expect(company.signals?.some((s) => s.type === "leadership_change")).toBe(true);
    expect(company.signals?.some((s) => s.type === "news_mention")).toBe(true);
  });
});
