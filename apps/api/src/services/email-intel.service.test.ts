import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSendEligibility, getWarmupStatus, startWarmup } from "./email-intel.service.js";

const CONFIGURED = { EMAIL_INTEL_SERVICE_URL: "http://email-intel.internal", EMAIL_INTEL_TIMEOUT_MS: 5000, EMAIL_INTEL_DISCOVER_TIMEOUT_MS: 60000 };
const UNCONFIGURED = { EMAIL_INTEL_SERVICE_URL: undefined, EMAIL_INTEL_TIMEOUT_MS: 5000, EMAIL_INTEL_DISCOVER_TIMEOUT_MS: 60000 };

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

describe("startWarmup", () => {
  it("POSTs domain/mailbox to /warmup/start and returns the upstream body", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, domain: "acme.com", mailbox: "sales@acme.com", status: "scheduled" }), {
        status: 200,
      })
    );
    const result = await startWarmup(CONFIGURED, { domain: "acme.com", mailbox: "sales@acme.com" });
    expect(result).toEqual({ success: true, domain: "acme.com", mailbox: "sales@acme.com", status: "scheduled" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://email-intel.internal/warmup/start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ domain: "acme.com", mailbox: "sales@acme.com" }),
      })
    );
  });

  it("throws EmailIntelUnavailableError when EMAIL_INTEL_SERVICE_URL isn't set", async () => {
    await expect(startWarmup(UNCONFIGURED, { domain: "acme.com" })).rejects.toThrow(
      "Email Intelligence service unavailable"
    );
  });

  it("throws EmailIntelUnavailableError when the upstream responds non-2xx (e.g. today's 501 scaffold response)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: "warmup_not_implemented" }), { status: 501 })
    );
    await expect(startWarmup(CONFIGURED, { domain: "acme.com" })).rejects.toMatchObject({ upstreamStatus: 501 });
  });
});

describe("verifyEmailResolved", () => {
  it("falls back to Hunter when upstream returns SMTP_ERROR", async () => {
    const { verifyEmailResolved } = await import("./email-intel.service.js");
    const { HunterEmailVerifier } = await import("@skout/pal");

    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          email: "test@gmail.com",
          domain: "gmail.com",
          verificationStatus: { status: "SMTP_ERROR" },
        }),
        { status: 200 }
      )
    );
    vi.spyOn(HunterEmailVerifier.prototype, "verify").mockResolvedValue({
      status: "risky",
      deliverabilityScore: 70,
      catchAll: false,
      risky: true,
    });

    const result = await verifyEmailResolved(
      { ...CONFIGURED, HUNTER_API_KEY: "test-key", HUNTER_BASE_URL: "https://api.hunter.io/v2", ENRICHMENT_REQUEST_TIMEOUT_MS: 5000 } as never,
      "test@gmail.com"
    );

    expect(result.provider).toBe("hunter-fallback");
    expect(result.verificationStatus?.status).toBe("UNKNOWN");
  });
});

describe("getWarmupStatus", () => {
  it("GETs /warmup/status with the domain as a query param and returns the upstream body", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ success: true, domain: "acme.com", enabled: false, phase: "scaffold", score: null, dayInProgram: null }),
        { status: 200 }
      )
    );
    const result = await getWarmupStatus(CONFIGURED, "acme.com");
    expect(result).toEqual({
      success: true,
      domain: "acme.com",
      enabled: false,
      phase: "scaffold",
      score: null,
      dayInProgram: null,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://email-intel.internal/warmup/status?domain=acme.com",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("throws EmailIntelUnavailableError when EMAIL_INTEL_SERVICE_URL isn't set", async () => {
    await expect(getWarmupStatus(UNCONFIGURED, "acme.com")).rejects.toThrow("Email Intelligence service unavailable");
  });
});
