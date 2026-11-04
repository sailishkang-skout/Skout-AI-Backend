import { describe, expect, it } from "vitest";
import type { HealthInputs } from "./cops-health.service.js";
import { CHURN_MODEL_VERSION, predictChurn, scoreSlopePer30d } from "./cops-churn.service.js";

const now = new Date("2026-11-03T00:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const healthy: HealthInputs = {
  activationPct: 100,
  firstLoginAt: daysAgo(80),
  activatedAt: daysAgo(70),
  lastActivityAt: daysAgo(3),
  meetings30d: 2,
  engagedContacts90d: 4,
  openTickets: 0,
  highOpenTickets: 0,
  tickets90d: 1,
  renewalAt: null,
  subscriptionStatus: "active",
  failedPayments: 0,
  credits30d: 500,
  creditsPrev30d: 450,
};

describe("COPS-14 churn prediction", () => {
  it("rates an engaged, growing account low and says why", () => {
    const p = predictChurn(healthy, [{ score: 85, computedAt: daysAgo(1) }], now);
    expect(p.band).toBe("low");
    expect(p.model_version).toBe(CHURN_MODEL_VERSION);
    expect(p.factors.some((f) => f.key === "engaged" && f.contribution < 0)).toBe(true);
  });

  it("rates a quiet account with failed payments and stopped usage high, biggest factor first", () => {
    const risky: HealthInputs = { ...healthy, lastActivityAt: daysAgo(60), meetings30d: 0, engagedContacts90d: 0, failedPayments: 2, subscriptionStatus: "past_due", credits30d: 0, creditsPrev30d: 300, renewalAt: daysAgo(-30) };
    const history = [
      { score: 80, computedAt: daysAgo(85) },
      { score: 62, computedAt: daysAgo(45) },
      { score: 41, computedAt: daysAgo(2) },
    ];
    const p = predictChurn(risky, history, now);
    expect(p.band).toBe("high");
    expect(p.probability).toBeGreaterThan(0.5);
    const abs = p.factors.map((f) => Math.abs(f.contribution));
    expect([...abs].sort((a, b) => b - a)).toEqual(abs);
    expect(p.factors.map((f) => f.key)).toEqual(expect.arrayContaining(["failed_payments", "usage_stopped", "quiet", "health_trend", "renewal_unengaged"]));
  });

  it("measures the score trend per 30 days", () => {
    expect(scoreSlopePer30d([{ score: 90, computedAt: daysAgo(60) }, { score: 70, computedAt: daysAgo(0) }])).toBeCloseTo(-10, 0);
    expect(scoreSlopePer30d([{ score: 90, computedAt: daysAgo(1) }])).toBeNull();
  });
});
