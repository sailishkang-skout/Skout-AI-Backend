import { describe, expect, it } from "vitest";
import {
  generateCompanyId,
  generateProspectId,
  hashEmail,
  normalizeDomain,
} from "./identity.js";

describe("identity", () => {
  it("normalizes company domains", () => {
    expect(normalizeDomain("  WWW.Example.COM/  ")).toBe("example.com");
    expect(normalizeDomain("https://www.stripe.com/about")).toBe("stripe.com");
    expect(normalizeDomain("http://openai.com/path?q=1")).toBe("openai.com");
  });

  it("hashes emails deterministically", () => {
    expect(hashEmail("User@Example.com")).toBe(hashEmail("user@example.com"));
  });

  it("generates stable prospect_id", () => {
    const a = generateProspectId("example.com", "user@example.com");
    const b = generateProspectId("www.example.com", "user@example.com");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("generates stable company_id", () => {
    const a = generateCompanyId("example.com");
    const b = generateCompanyId("www.example.com");
    expect(a).toBe(b);
  });
});
