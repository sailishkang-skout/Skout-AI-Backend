import { describe, expect, it } from "vitest";
import { isPlatformAdmin, buildScopeKey } from "./regional-brief.service.js";

describe("isPlatformAdmin", () => {
  it("returns true for an email in PLATFORM_ADMIN_EMAILS, case-insensitively", () => {
    const config = { PLATFORM_ADMIN_EMAILS: ["admin@skoutai.io"] };
    expect(isPlatformAdmin(config, "Admin@SkoutAI.io")).toBe(true);
  });

  it("returns false for an email not in the list", () => {
    const config = { PLATFORM_ADMIN_EMAILS: ["admin@skoutai.io"] };
    expect(isPlatformAdmin(config, "someone-else@skoutai.io")).toBe(false);
  });

  it("returns false when email is undefined", () => {
    const config = { PLATFORM_ADMIN_EMAILS: ["admin@skoutai.io"] };
    expect(isPlatformAdmin(config, undefined)).toBe(false);
  });

  it("returns false when the allowlist is empty", () => {
    const config = { PLATFORM_ADMIN_EMAILS: [] };
    expect(isPlatformAdmin(config, "admin@skoutai.io")).toBe(false);
  });
});

describe("buildScopeKey", () => {
  it("builds a global-layer key from just the field category", () => {
    expect(buildScopeKey({ layerType: "global", fieldCategory: "explainability" })).toBe(
      "global:explainability"
    );
  });

  it("builds a country-layer key from the country id", () => {
    expect(
      buildScopeKey({ layerType: "country", countryId: "c-1", fieldCategory: "market_economics" })
    ).toBe("country:c-1:market_economics");
  });

  it("builds a tenant-layer key from workspace + country", () => {
    expect(
      buildScopeKey({
        layerType: "tenant",
        workspaceId: "ws-1",
        countryId: "c-1",
        fieldCategory: "channel_policy",
      })
    ).toBe("tenant:ws-1:c-1:channel_policy");
  });
});
