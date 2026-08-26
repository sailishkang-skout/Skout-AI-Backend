import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../config/env.js";

const generateRegionalBriefMock = vi.fn();
vi.mock("./regional-intel.service.js", () => ({
  generateRegionalBrief: generateRegionalBriefMock,
}));

const pinAiClaimMock = vi.fn().mockResolvedValue({ evidenceId: "ev-1", modelVersionId: "mv-1", promptVersionId: "pv-1" });
vi.mock("./ai-evidence.service.js", () => ({
  pinAiClaim: pinAiClaimMock,
}));

const { personalizeProspect } = await import("./personalize.service.js");

const baseConfig = { AI_SERVICE_URL: undefined, OPENROUTER_API_KEY: undefined } as unknown as Env;

describe("personalizeProspect — R10.3 / §16 regional tone", () => {
  beforeEach(() => {
    generateRegionalBriefMock.mockReset();
    pinAiClaimMock.mockClear();
  });

  it("does not call generateRegionalBrief when the prospect's country is unknown", async () => {
    await personalizeProspect(null, baseConfig, "unknown", {
      prospectId: "p-1",
      fullName: "Jamie",
      companyDomain: "acme.com",
    });

    expect(generateRegionalBriefMock).not.toHaveBeenCalled();
  });

  it("fetches a regional brief for the prospect's country and forwards its tone to the AI service", async () => {
    generateRegionalBriefMock.mockResolvedValue({ outreachTone: "direct, low-context" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ opener: "Hi", talkingPoints: [], source: "llm" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await personalizeProspect(null, { ...baseConfig, AI_SERVICE_URL: "http://ai.local", ENRICHMENT_AI_TIMEOUT_MS: 5000 } as unknown as Env, "unknown", {
      prospectId: "p-1",
      companyDomain: "acme.com",
      companyCountry: "DE",
    });

    expect(generateRegionalBriefMock).toHaveBeenCalledWith({ location: "DE", purpose: "territory" }, undefined);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(requestInit.body as string);
    expect(sentBody.regional_tone).toBe("direct, low-context");

    vi.unstubAllGlobals();
  });

  it("is best-effort — a failed regional brief never blocks draft generation", async () => {
    generateRegionalBriefMock.mockRejectedValue(new Error("openrouter down"));

    const result = await personalizeProspect(null, baseConfig, "unknown", {
      prospectId: "p-1",
      fullName: "Jamie",
      companyDomain: "acme.com",
      companyCountry: "IN",
    });

    expect(result.opener).toContain("Jamie");
  });
});
