import { describe, expect, it } from "vitest";
import { EnrichmentEngine } from "./engine.js";
import { generateEmailCandidates } from "./email-patterns.js";

describe("email-patterns", () => {
  it("generates ranked candidates", () => {
    const c = generateEmailCandidates("John Smith", "acme.com");
    expect(c[0]).toBe("john.smith@acme.com");
    expect(c).toContain("jsmith@acme.com");
  });

  it("strips protocol and www from domain", () => {
    const c = generateEmailCandidates("Jane Doe", "https://www.example.com/team");
    expect(c.every((e) => e.endsWith("@example.com"))).toBe(true);
  });
});

describe("EnrichmentEngine", () => {
  it("enriches company + email + validation by default", async () => {
    const engine = new EnrichmentEngine();
    const out = await engine.enrich({
      prospectId: "p1",
      fullName: "John Smith",
      companyDomain: "acme.com",
    });
    expect(out.results.some((r) => r.field === "company")).toBe(true);
    expect(out.results.some((r) => r.field === "email")).toBe(true);
    expect(out.creditsUsed).toBeGreaterThan(0);
  });

  it("skips phone when lead score is at or below the gate", async () => {
    const engine = new EnrichmentEngine();
    const out = await engine.enrich({
      prospectId: "p1",
      fullName: "John Smith",
      companyDomain: "acme.com",
      fields: ["phone"],
      leadScore: 50,
    });
    expect(out.results.some((r) => r.field === "phone")).toBe(false);
    expect(out.attempts.some((a) => a.operation === "score-gate" && a.status === "skipped")).toBe(true);
  });

  it("attempts phone when lead score exceeds the gate", async () => {
    const engine = new EnrichmentEngine();
    const out = await engine.enrich({
      prospectId: "p1",
      fullName: "Jane Doe",
      companyDomain: "example.com",
      fields: ["phone"],
      leadScore: 95,
    });
    expect(out.attempts.some((a) => a.operation === "fetchPhone")).toBe(true);
  });
});
