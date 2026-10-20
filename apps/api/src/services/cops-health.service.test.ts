import { describe, expect, it } from "vitest";
import { computeHealth, DEFAULT_HEALTH_MODEL, HEALTH_DIMENSIONS, signalCycle, type HealthInputs } from "./cops-health.service.js";

const now = new Date("2026-10-20T00:00:00Z");
const healthy: HealthInputs = {
  activationPct: 100,
  firstLoginAt: new Date("2026-09-01"),
  activatedAt: new Date("2026-09-10"),
  lastActivityAt: new Date("2026-10-18"),
  meetings30d: 2,
  engagedContacts90d: 3,
  openTickets: 0,
  highOpenTickets: 0,
  tickets90d: 1,
  renewalAt: new Date("2027-06-01"),
  subscriptionStatus: "active",
  failedPayments: 0,
};

describe("computeHealth (COPS-11)", () => {
  it("every dimension's score is 100 plus its factors' points: the breakdown explains the score", () => {
    const r = computeHealth({ ...healthy, openTickets: 2, highOpenTickets: 1, meetings30d: 0, lastActivityAt: new Date("2026-09-01") }, DEFAULT_HEALTH_MODEL, now);
    for (const d of HEALTH_DIMENSIONS) {
      const sum = 100 + r.factors.filter((f) => f.dimension === d).reduce((s, f) => s + f.points, 0);
      expect(r.dimensions[d].score).toBe(Math.max(0, Math.min(100, sum)));
    }
    const weighted = HEALTH_DIMENSIONS.reduce((s, d) => s + r.dimensions[d].score * r.dimensions[d].weight, 0) / 100;
    expect(r.score).toBe(Math.round(weighted));
    expect(r.factors.every((f) => f.reason.length > 0 && (f.kind === "leading" || f.kind === "lagging"))).toBe(true);
    expect(r.factors.find((f) => f.key === "open_tickets")).toMatchObject({ kind: "leading", points: -30, reason: "2 open ticket(s)" });
    expect(r.factors.find((f) => f.key === "activation")?.kind).toBe("lagging");
  });

  it("a healthy account scores healthy; trouble on several dimensions makes it at risk", () => {
    expect(computeHealth(healthy, DEFAULT_HEALTH_MODEL, now).state).toBe("healthy");
    const bad = computeHealth(
      { ...healthy, activationPct: 20, firstLoginAt: null, lastActivityAt: null, meetings30d: 0, engagedContacts90d: 0, openTickets: 3, highOpenTickets: 1, subscriptionStatus: "past_due", failedPayments: 2 },
      DEFAULT_HEALTH_MODEL,
      now
    );
    expect(bad.state).toBe("at_risk");
    expect(bad.renewalRisk).toBe("high");
  });

  it("raises signals with evidence: low adoption after activation, ticket-heavy, renewal approaching", () => {
    const r = computeHealth({ ...healthy, activationPct: 30, firstLoginAt: null, openTickets: 3, renewalAt: new Date("2026-12-01") }, DEFAULT_HEALTH_MODEL, now);
    expect(r.signals.map((s) => s.signal).sort()).toEqual(["low_adoption", "renewal_approaching", "ticket_heavy"]);
    expect(r.signals.find((s) => s.signal === "ticket_heavy")?.evidence[0]).toMatchObject({ factor: "open_tickets", reason: "3 open ticket(s)" });
    expect(computeHealth(healthy, DEFAULT_HEALTH_MODEL, now).signals).toEqual([]);
  });

  it("a renewal signal's cycle is the renewal date; others are the month", () => {
    expect(signalCycle("renewal_approaching", now, new Date("2026-12-01T00:00:00Z"))).toBe("renewal:2026-12-01");
    expect(signalCycle("ticket_heavy", now, null)).toBe("month:2026-10");
  });
});
