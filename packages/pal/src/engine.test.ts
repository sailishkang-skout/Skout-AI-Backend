import { describe, expect, it } from "vitest";
import { EnrichmentEngine, finalizeBillableCredits } from "./engine.js";
import { createStubRegistry } from "./adapters/stub.js";
import { generateEmailCandidates } from "./email-patterns.js";
import type { EmailFinder, FoundEmail, PhoneData, PhoneProvider } from "./types.js";

class FixedEmailFinder implements EmailFinder {
  constructor(
    readonly name: string,
    private readonly result: FoundEmail | null
  ) {}
  async findEmail(): Promise<FoundEmail | null> {
    return this.result;
  }
}

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
    expect(out.results.some((r) => r.field === "phone" && r.validationStatus === "skipped")).toBe(true);
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

  it("falls through phone providers and reports all attempts on failure", async () => {
    class FailPhone implements PhoneProvider {
      constructor(readonly name: string) {}
      async fetchPhone(): Promise<PhoneData | null> {
        throw new Error(`${this.name} failed`);
      }
    }
    const engine = new EnrichmentEngine({
      ...createStubRegistry(),
      phone: [new FailPhone("datagma"), new FailPhone("contactout")],
    });
    const out = await engine.enrich({
      prospectId: "p1",
      fullName: "Jane Doe",
      companyDomain: "example.com",
      fields: ["phone"],
      leadScore: 95,
    });
    const phone = out.results.find((r) => r.field === "phone");
    expect(phone?.provider).toBe("contactout");
    expect(phone?.valueJson).toMatchObject({
      providersTried: [
        { provider: "datagma", status: "error", detail: "datagma failed" },
        { provider: "contactout", status: "error", detail: "contactout failed" },
      ],
    });
  });

  it("bills workspace keys at 75% of platform rate", () => {
    const fourWorkspaceSteps = 4 * 3;
    const fourPlatformSteps = 4 * 4;
    expect(finalizeBillableCredits(fourWorkspaceSteps)).toBe(3);
    expect(finalizeBillableCredits(fourPlatformSteps)).toBe(4);
  });

  it("does not pattern-generate emails for LinkedIn capture domains", async () => {
    const engine = new EnrichmentEngine();
    const out = await engine.enrich({
      prospectId: "p1",
      fullName: "Alex Founder",
      companyDomain: "openchat.linkedin",
      companyName: "OpenChat",
      linkedinUrl: "https://www.linkedin.com/in/alex-founder/",
      fields: ["email"],
    });
    expect(out.results.some((r) => r.field === "email" && r.provider === "pattern-gen")).toBe(false);
  });

  it("uses internal_graph cache before paid email finders", async () => {
    const engine = new EnrichmentEngine();
    const out = await engine.enrich({
      prospectId: "p1",
      fullName: "Jane Doe",
      companyDomain: "acme.com",
      cachedEmail: "jane@acme.com",
      fields: ["email", "validation"],
    });
    expect(out.attempts.some((a) => a.provider === "internal_graph" && a.operation === "lookupEmail")).toBe(
      true
    );
    expect(out.results.some((r) => r.field === "email" && r.provider === "internal_graph")).toBe(true);
  });

  describe("email quality threshold (8.3 workbook)", () => {
    it("accepts the first provider's result when no threshold is set (default behavior unchanged)", async () => {
      const engine = new EnrichmentEngine({
        ...createStubRegistry(),
        emailFinders: [
          new FixedEmailFinder("low-conf", { email: "a@acme.com", confidence: 0.2 }),
          new FixedEmailFinder("high-conf", { email: "b@acme.com", confidence: 0.9 }),
        ],
      });
      const out = await engine.enrich({
        prospectId: "p1",
        fullName: "Jane Doe",
        companyDomain: "acme.com",
        fields: ["email"],
      });
      const email = out.results.find((r) => r.field === "email");
      expect(email?.provider).toBe("low-conf");
      expect(out.attempts.some((a) => a.operation === "quality-gate")).toBe(false);
    });

    it("tries the next provider when the result is below the quality threshold", async () => {
      const engine = new EnrichmentEngine({
        ...createStubRegistry(),
        emailFinders: [
          new FixedEmailFinder("low-conf", { email: "a@acme.com", confidence: 0.2 }),
          new FixedEmailFinder("high-conf", { email: "b@acme.com", confidence: 0.9 }),
        ],
      });
      const out = await engine.enrich({
        prospectId: "p1",
        fullName: "Jane Doe",
        companyDomain: "acme.com",
        fields: ["email"],
        emailQualityThreshold: 0.5,
      });
      const email = out.results.find((r) => r.field === "email");
      expect(email?.provider).toBe("high-conf");
      expect(email?.confidence).toBe(0.9);
      expect(
        out.attempts.some((a) => a.provider === "low-conf" && a.operation === "quality-gate" && a.status === "skipped")
      ).toBe(true);
    });

    it("falls back to the best candidate seen when no provider meets the threshold", async () => {
      const engine = new EnrichmentEngine({
        ...createStubRegistry(),
        emailFinders: [
          new FixedEmailFinder("weak", { email: "a@acme.com", confidence: 0.2 }),
          new FixedEmailFinder("less-weak", { email: "b@acme.com", confidence: 0.4 }),
        ],
      });
      const out = await engine.enrich({
        prospectId: "p1",
        fullName: "Jane Doe",
        companyDomain: "acme.com",
        fields: ["email"],
        emailQualityThreshold: 0.9,
      });
      const email = out.results.find((r) => r.field === "email");
      expect(email?.provider).toBe("less-weak");
      expect(email?.confidence).toBe(0.4);
    });

    it("bills every provider it actually queried while chasing the threshold, not just the winner", async () => {
      const engine = new EnrichmentEngine({
        ...createStubRegistry(),
        emailFinders: [
          new FixedEmailFinder("first", { email: "a@acme.com", confidence: 0.2 }),
          new FixedEmailFinder("second", { email: "b@acme.com", confidence: 0.9 }),
        ],
      });
      const out = await engine.enrich({
        prospectId: "p1",
        fullName: "Jane Doe",
        companyDomain: "acme.com",
        fields: ["email"],
        emailQualityThreshold: 0.5,
      });
      expect(out.attempts.filter((a) => a.operation === "findEmail" && a.status === "ok")).toHaveLength(2);
      expect(out.creditsUsed).toBeGreaterThan(0);
    });
  });
});
