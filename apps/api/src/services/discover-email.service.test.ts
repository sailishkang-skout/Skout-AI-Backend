import { afterEach, describe, expect, it, vi } from "vitest";

const { resolveMx } = vi.hoisted(() => ({
  resolveMx: vi.fn(),
}));

vi.mock("node:dns", () => ({
  promises: { resolveMx },
}));

import {
  assertDiscoverDomain,
  discoverEmailResolved,
  normalizeDiscoverDomain,
} from "./discover-email.service.js";

const CONFIG = {
  EMAIL_INTEL_SERVICE_URL: "http://email-intel.internal",
  EMAIL_INTEL_TIMEOUT_MS: 5000,
  EMAIL_INTEL_DISCOVER_TIMEOUT_MS: 60000,
  HUNTER_API_KEY: "test-hunter-key",
  HUNTER_BASE_URL: "https://api.hunter.io/v2",
  ENRICHMENT_REQUEST_TIMEOUT_MS: 5000,
} as any;

afterEach(() => {
  vi.restoreAllMocks();
  resolveMx.mockReset();
});

describe("normalizeDiscoverDomain", () => {
  it("strips scheme and www", () => {
    expect(normalizeDiscoverDomain("https://www.Microsoft.com/about")).toBe("microsoft.com");
  });
});

describe("assertDiscoverDomain", () => {
  it("rejects empty domains", () => {
    expect(() => assertDiscoverDomain("   ")).toThrow("invalid_domain");
  });
});

describe("discoverEmailResolved", () => {
  it("rejects domains without MX records", async () => {
    resolveMx.mockRejectedValue(new Error("ENOTFOUND"));

    await expect(
      discoverEmailResolved(CONFIG, { firstName: "John", lastName: "Smith", domain: "microsft.invalid" })
    ).rejects.toMatchObject({ message: "domain_no_mx", statusCode: 422 });
  });

  it("falls back to Hunter when upstream is unavailable", async () => {
    resolveMx.mockResolvedValue([{ exchange: "mx.microsoft.com", priority: 10 }]);
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const { HunterEmailFinder, HunterEmailVerifier } = await import("@skout/pal");
    vi.spyOn(HunterEmailFinder.prototype, "findEmail").mockResolvedValue({
      email: "john.smith@microsoft.com",
      confidence: 0.92,
    });
    vi.spyOn(HunterEmailVerifier.prototype, "verify").mockResolvedValue({
      status: "valid",
      deliverabilityScore: 90,
      catchAll: false,
      risky: false,
    });

    const result = await discoverEmailResolved(CONFIG, {
      firstName: "John",
      lastName: "Smith",
      domain: "microsoft.com",
    });

    expect(result.success).toBe(true);
    expect(result.recommendedEmail).toBe("john.smith@microsoft.com");
    expect(result.provider).toBe("hunter-fallback");
  });

  it("filters upstream candidates that do not match the requested domain", async () => {
    resolveMx.mockResolvedValue([{ exchange: "mx.microsoft.com", priority: 10 }]);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          firstName: "John",
          lastName: "Smith",
          domain: "microsoft.com",
          recommendedEmail: "john.smith@wrong.com",
          recommendedPattern: "first.last",
          recommendedConfidence: 80,
          candidates: [
            {
              email: "john.smith@wrong.com",
              pattern: "first.last",
              finalScore: 80,
              decision: "GOOD",
              confidence: 80,
              reasons: [],
            },
            {
              email: "john.smith@microsoft.com",
              pattern: "first.last",
              finalScore: 75,
              decision: "GOOD",
              confidence: 75,
              reasons: [],
            },
          ],
        }),
        { status: 200 }
      )
    );

    const result = await discoverEmailResolved(CONFIG, {
      firstName: "John",
      lastName: "Smith",
      domain: "microsoft.com",
    });

    expect(result.recommendedEmail).toBe("john.smith@microsoft.com");
    expect(result.candidates).toHaveLength(1);
  });

  it("surfaces upstream 4xx errors instead of masking them as unavailable", async () => {
    resolveMx.mockResolvedValue([{ exchange: "mx.microsoft.com", priority: 10 }]);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_domain" }), { status: 422 })
    );

    await expect(
      discoverEmailResolved({ ...(CONFIG as any), HUNTER_API_KEY: undefined } as any, {
        firstName: "John",
        domain: "microsoft.com",
      })
    ).rejects.toMatchObject({ message: "email_intel_rejected", statusCode: 422 });
  });
});
