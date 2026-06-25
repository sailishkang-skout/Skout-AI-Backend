import { describe, expect, it } from "vitest";
import { cleanCompanies } from "./company-cleaner.js";
import { recordsToDocs } from "../../ingestor/src/index.js";
import { extractFirmographics } from "../../orchestrator/src/bots/company-web-extract.js";

const STRIPE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Stripe | Financial Infrastructure to Grow Your Revenue</title>
  <meta name="description" content="Stripe is a suite of APIs powering online payment processing and commerce solutions." />
  <meta property="og:site_name" content="Stripe" />
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "Stripe, Inc.",
    "description": "Online payment processing for internet businesses.",
    "foundingDate": "2010",
    "numberOfEmployees": 8000,
    "address": {
      "@type": "PostalAddress",
      "addressLocality": "San Francisco",
      "addressRegion": "CA",
      "addressCountry": "US"
    }
  }
  </script>
</head>
<body>
  <h1>Financial infrastructure for the internet</h1>
  <p>Founded in 2010, Stripe powers millions of businesses worldwide with 8,000+ employees.</p>
  <a href="/careers">We're hiring — see open roles</a>
  <div data-job-id="eng-1">Software Engineer</div>
  <div data-job-id="eng-2">Product Manager</div>
  <script src="https://js.stripe.com/v3/"></script>
</body>
</html>
`;

describe("company-web E2E pipeline smoke", () => {
  it("stripe.com raw → clean → ingest docs > 0 with firmographics", () => {
    const hints = extractFirmographics(STRIPE_HTML, "stripe.com");
    expect(hints.companyName).toBe("Stripe");
    expect(hints.foundedYear).toBe(2010);
    expect(hints.employeeCount).toBeGreaterThan(1000);

    const scrapedAt = new Date().toISOString();
    const { clean, quarantined } = cleanCompanies([
      {
        source: "company-web",
        scrapedAt,
        payload: {
          domain: "stripe.com",
          companyName: hints.companyName,
          description: hints.description,
          industry: hints.industry ?? "Financial Services",
          employeeCount: hints.employeeCount,
          foundedYear: hints.foundedYear,
          hqCity: hints.hqCity,
          hqState: hints.hqState,
          hqCountry: hints.hqCountry,
          companyStage: hints.companyStage,
          html: STRIPE_HTML,
          isHiring: true,
          openJobs: 2,
        },
      },
    ]);

    expect(quarantined).toHaveLength(0);
    expect(clean.length).toBeGreaterThan(0);

    const company = clean[0]!;
    expect(company.domain).toBe("stripe.com");
    expect(company.provenance?.length).toBeGreaterThan(0);
    expect(company.signals?.some((s) => s.type === "recent_hiring")).toBe(true);

    const docs = recordsToDocs(clean);
    expect(docs.length).toBeGreaterThan(0);
    const doc = docs[0]!;
    expect(doc.companyDomain).toBe("stripe.com");
    expect(doc.currentlyHiring).toBe(true);
    expect(doc.foundedYear).toBe(2010);
    expect(doc.employeeCount).toBeGreaterThan(1000);
    expect(doc.employeeBucket).toBe("1000+");
  });
});
