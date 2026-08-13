import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSendEligibility } from "./email-intel.service.js";

const CONFIGURED = { EMAIL_INTEL_SERVICE_URL: "http://email-intel.internal", EMAIL_INTEL_TIMEOUT_MS: 5000 };
const UNCONFIGURED = { EMAIL_INTEL_SERVICE_URL: undefined, EMAIL_INTEL_TIMEOUT_MS: 5000 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkSendEligibility", () => {
  it("returns allowed:true without a network call when EMAIL_INTEL_SERVICE_URL isn't set", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const result = await checkSendEligibility(UNCONFIGURED, "ada@acme.com");
    expect(result).toEqual({ allowed: true, decision: "NOT_CONFIGURED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes through a blocking policy decision from the upstream service", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          email: "ada@acme.com",
          domain: "acme.com",
          disposable: false,
          sendEligibility: { allowed: false, decision: "MANUAL_REVIEW", decisionConfidence: 80, reason: "Catch-all domain" },
        }),
        { status: 200 }
      )
    );
    const result = await checkSendEligibility(CONFIGURED, "ada@acme.com");
    expect(result).toEqual({
      allowed: false,
      decision: "MANUAL_REVIEW",
      reason: "Catch-all domain",
      decisionConfidence: 80,
    });
  });

  it("fails open when the upstream call throws", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await checkSendEligibility(CONFIGURED, "ada@acme.com");
    expect(result).toEqual({ allowed: true, decision: "UNAVAILABLE" });
  });

  it("fails open when the response has no sendEligibility block", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, email: "ada@acme.com", domain: "acme.com", disposable: false }), {
        status: 200,
      })
    );
    const result = await checkSendEligibility(CONFIGURED, "ada@acme.com");
    expect(result).toEqual({ allowed: true, decision: "NO_DECISION" });
  });
});
