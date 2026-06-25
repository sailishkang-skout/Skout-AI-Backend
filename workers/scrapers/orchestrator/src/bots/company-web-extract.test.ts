import { describe, expect, it } from "vitest";
import { extractFirmographics, cleanCompanyName } from "./company-web-extract.js";

describe("company-web-extract", () => {
  it("parses JSON-LD organization block", () => {
    const html = `
      <title>Stripe | Payments</title>
      <script type="application/ld+json">{"@type":"Organization","name":"Stripe","foundingDate":"2010","numberOfEmployees":8000}</script>
    `;
    const hints = extractFirmographics(html, "stripe.com");
    expect(hints.companyName).toBe("Stripe");
    expect(hints.foundedYear).toBe(2010);
    expect(hints.employeeCount).toBe(8000);
  });

  it("cleans noisy page titles", () => {
    expect(cleanCompanyName("Acme Corp | Home", undefined, "acme.com")).toBe("Acme Corp");
    expect(cleanCompanyName(undefined, "Stripe", "stripe.com")).toBe("Stripe");
  });
});
