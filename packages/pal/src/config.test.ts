import { describe, expect, it } from "vitest";
import { createRegistryFromConfig, hasLiveProviders } from "./config.js";

describe("createRegistryFromConfig", () => {
  it("falls back to stub adapters when no keys are set", () => {
    const reg = createRegistryFromConfig({});
    expect(reg.emailFinders[0].name).toBe("stub-hunter");
    expect(reg.emailVerifiers[0].name).toBe("stub-verifier");
    expect(reg.firmographics[0].name).toBe("stub-firmographics");
    expect(reg.phone[0].name).toBe("stub-datagma");
    expect(hasLiveProviders({})).toBe(false);
  });

  it("selects live adapters for the capabilities whose keys are present", () => {
    const reg = createRegistryFromConfig({
      hunterApiKey: "h",
      millionVerifierApiKey: "m",
      zeroBounceApiKey: "z",
      pdlApiKey: "p",
      datagmaApiKey: "d",
      contactOutApiKey: "co",
      revenueBaseApiKey: "r",
      exploriumApiKey: "e",
      coresignalApiKey: "c",
      cognismApiKey: "g",
    });
    expect(reg.emailFinders[0].name).toBe("hunter");
    expect(reg.emailVerifiers.map((v) => v.name)).toEqual(["millionverifier", "zerobounce"]);
    expect(reg.firmographics.map((f) => f.name)).toEqual([
      "peopledatalabs",
      "revenuebase",
      "explorium",
      "coresignal",
    ]);
    expect(reg.phone.map((p) => p.name)).toEqual(["datagma", "contactout", "cognism"]);
    expect(hasLiveProviders({ hunterApiKey: "h" })).toBe(true);
  });

  it("uses the Hunter verifier only when no dedicated verifier key is set", () => {
    const reg = createRegistryFromConfig({ hunterApiKey: "h" });
    expect(reg.emailVerifiers.map((v) => v.name)).toEqual(["hunter-verify"]);
  });

  it("keeps provider methods after BYOK credential wrapping", () => {
    const reg = createRegistryFromConfig({
      revenueBaseApiKey: "r",
      exploriumApiKey: "e",
      millionVerifierApiKey: "m",
      zeroBounceApiKey: "z",
    });
    for (const p of reg.firmographics) {
      expect(typeof p.fetchCompany).toBe("function");
    }
    for (const p of reg.emailVerifiers) {
      expect(typeof p.verify).toBe("function");
    }
  });
});
