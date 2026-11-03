import { describe, expect, it } from "vitest";
import { currentPeriod, PLAN_LIMITS, usageVerdict } from "./cops-usage.service.js";
import { isMeteredAi } from "../routes/cops-usage.routes.js";

describe("COPS-14 metered usage", () => {
  it("uses the plan limits from the pricing decision", () => {
    expect(PLAN_LIMITS.full).toMatchObject({ ai_actions: 1000, identities: 1 });
    expect(PLAN_LIMITS.multichannel).toMatchObject({ ai_actions: 5000, identities: 2 });
  });
  it("warns at 80% and stops past the limit", () => {
    expect(usageVerdict(500, 1, 1000)).toEqual({ allowed: true, warn: false, remaining: 499 });
    expect(usageVerdict(799, 1, 1000).warn).toBe(true);
    expect(usageVerdict(999, 1, 1000)).toEqual({ allowed: true, warn: true, remaining: 0 });
    expect(usageVerdict(1000, 1, 1000).allowed).toBe(false);
    expect(usageVerdict(1, 1, 1).allowed).toBe(false);
  });
  it("counts per calendar month", () => {
    expect(currentPeriod(new Date("2026-11-03T10:00:00Z"))).toBe("2026-11");
  });
  it("meters only user-triggered AI routes", () => {
    expect(isMeteredAi("POST", "/api/v1/ai/chat")).toBe(true);
    expect(isMeteredAi("POST", "/api/v1/ai/generate-email?x=1")).toBe(true);
    expect(isMeteredAi("GET", "/api/v1/ai/drafts")).toBe(false);
    expect(isMeteredAi("POST", "/api/v1/ai/drafts/abc/approve")).toBe(false);
    expect(isMeteredAi("POST", "/api/v1/tickets")).toBe(false);
  });
});
