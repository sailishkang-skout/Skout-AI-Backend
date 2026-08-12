import { describe, expect, it, vi, beforeEach } from "vitest";

const checkSendEligibility = vi.fn();
vi.mock("./email-intel.service.js", () => ({
  checkSendEligibility: (...args: unknown[]) => checkSendEligibility(...args),
}));

const { isSendBlockedByEligibility } = await import("./send-eligibility-guard.service.js");

const CONFIG = { EMAIL_INTEL_SERVICE_URL: "http://email-intel.internal", EMAIL_INTEL_TIMEOUT_MS: 5000 } as never;

beforeEach(() => vi.clearAllMocks());

describe("isSendBlockedByEligibility", () => {
  it("does not block when the policy engine allows the send", async () => {
    checkSendEligibility.mockResolvedValue({ allowed: true, decision: "USE_EMAIL" });
    const result = await isSendBlockedByEligibility(CONFIG, "ada@acme.com");
    expect(result.blocked).toBe(false);
  });

  it("blocks when the policy engine disallows the send, with a reason", async () => {
    checkSendEligibility.mockResolvedValue({
      allowed: false,
      decision: "MANUAL_REVIEW",
      reason: "Catch-all domain requires manual review",
    });
    const result = await isSendBlockedByEligibility(CONFIG, "ada@acme.com");
    expect(result).toEqual({ blocked: true, reason: "Catch-all domain requires manual review" });
  });

  it("falls back to the decision code when no reason string is given", async () => {
    checkSendEligibility.mockResolvedValue({ allowed: false, decision: "DO_NOT_USE" });
    const result = await isSendBlockedByEligibility(CONFIG, "ada@acme.com");
    expect(result).toEqual({ blocked: true, reason: "DO_NOT_USE" });
  });

  it("fails open (never blocks) if the eligibility check itself throws", async () => {
    checkSendEligibility.mockRejectedValue(new Error("upstream down"));
    const result = await isSendBlockedByEligibility(CONFIG, "ada@acme.com");
    expect(result.blocked).toBe(false);
  });
});
