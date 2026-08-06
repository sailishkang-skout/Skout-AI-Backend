import { describe, expect, it } from "vitest";
import { cadenceIntervalMs, computeNextRefreshAt } from "./smart-list-cadence.js";

describe("smart-list-cadence", () => {
  it("returns null next-refresh for cadence 'off'", () => {
    expect(computeNextRefreshAt("off", new Date("2026-01-01T00:00:00Z"))).toBeNull();
  });

  it("advances by 24h for 'daily'", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const next = computeNextRefreshAt("daily", from);
    expect(next?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(cadenceIntervalMs("daily")).toBe(24 * 60 * 60 * 1000);
  });

  it("advances by 7 days for 'weekly'", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const next = computeNextRefreshAt("weekly", from);
    expect(next?.toISOString()).toBe("2026-01-08T00:00:00.000Z");
    expect(cadenceIntervalMs("weekly")).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
