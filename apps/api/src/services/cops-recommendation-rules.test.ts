import { describe, expect, it } from "vitest";
import { recommendationCandidates, type AccountContext } from "./cops-recommendation-rules.js";

const now = new Date("2026-10-21T00:00:00Z");
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
const base = (over: Partial<AccountContext> = {}): AccountContext => ({
  now,
  account: { id: "a1", name: "Acme", healthScore: 70, healthState: "healthy", healthComputedAt: now },
  signals: [],
  ...over,
});
const types = (c: AccountContext) => recommendationCandidates(c).map((x) => x.type);

describe("COPS-13 recommendation rules", () => {
  it("a healthy account with nothing pending gets no recommendation", () => {
    expect(recommendationCandidates(base({ subscriptions: [{ id: "s1", status: "active", termEnd: days(30), arrMinor: 1_200_000, currency: "INR" }], tickets: [], overdueInvoices: [] }))).toEqual([]);
  });

  it("renewal within 90 days on weak health starts the renewal playbook, with the subscription and health as evidence", () => {
    const [c] = recommendationCandidates(
      base({ account: { id: "a1", name: "Acme", healthScore: 30, healthState: "at_risk", healthComputedAt: now }, subscriptions: [{ id: "s1", status: "active", termEnd: days(30), arrMinor: 1_200_000, currency: "INR" }] })
    );
    expect(c).toMatchObject({ type: "renewal_risk", resource: "commercial", action: { kind: "start_playbook", params: { playbook_key: "cs_renewal_approaching" } } });
    expect(c!.evidence.map((e) => e.kind)).toEqual(["subscription", "health_score"]);
    expect(c!.confidence).toBeGreaterThan(0.5);
    expect(c!.confidence).toBeLessThanOrEqual(0.95);
    expect(c!.dedupeKey).toBe("renewal_risk:s1:2026-11-20");
    // No renewal far out, or already past.
    expect(types(base({ account: { id: "a1", name: "Acme", healthScore: 30, healthState: "at_risk", healthComputedAt: now }, subscriptions: [{ id: "s2", status: "active", termEnd: days(200), arrMinor: 1, currency: "INR" }] }))).toEqual([]);
  });

  it("without commercial data (no permission) the renewal rule does not fire", () => {
    expect(types(base({ account: { id: "a1", name: "Acme", healthScore: 30, healthState: "at_risk", healthComputedAt: now } }))).toEqual([]);
  });

  it("trial ending and not activated; stalled onboarding; neither once activated", () => {
    const onboarding = { trials: [{ id: "p1", trialEndsAt: days(3) }], activated: false, stalledSignals: [{ id: "g1", trigger: "delivered_no_login", firedAt: days(-2) }] };
    expect(types(base({ onboarding }))).toEqual(["trial_not_activated", "stalled_onboarding"]);
    expect(types(base({ onboarding: { ...onboarding, activated: true } }))).toEqual([]);
    expect(types(base({ onboarding: { ...onboarding, trials: [{ id: "p1", trialEndsAt: days(20) }], stalledSignals: [{ id: "g1", trigger: "no_delivery", firedAt: days(-30) }] } }))).toEqual([]);
    // first_login is good news, not a stall.
    expect(types(base({ onboarding: { trials: [], activated: false, stalledSignals: [{ id: "g2", trigger: "first_login", firedAt: days(-1) }] } }))).toEqual([]);
    const [stall] = recommendationCandidates(base({ onboarding: { trials: [], activated: false, stalledSignals: [{ id: "g3", trigger: "delivered_no_login", firedAt: days(-1) }] } }));
    expect(stall!.headline).toBe("Onboarding stalled: the onboarding email was delivered but nobody has signed in");
  });

  it("ticket-heavy and SLA breached cite the tickets and clocks", () => {
    const tickets = [
      { id: "t1", title: "Down", priority: "p1", severity: "critical", breachedClockIds: ["c1"] },
      { id: "t2", title: "Slow", priority: "p3", severity: "high", breachedClockIds: [] },
    ];
    const cs = recommendationCandidates(base({ tickets }));
    expect(cs.map((c) => c.type)).toEqual(["ticket_heavy", "sla_breached"]);
    expect(cs[1]!.evidence).toEqual([
      { kind: "ticket", id: "t1", label: "P1 Down" },
      { kind: "sla_clock", id: "c1", label: "SLA clock breached" },
    ]);
    expect(types(base({ tickets: [tickets[1]!] }))).toEqual([]);
  });

  it("overdue bills and expansion signals", () => {
    const cs = recommendationCandidates(base({ overdueInvoices: [{ id: "i1", dueAt: days(-20), amountMinor: 100_000, currency: "USD" }], signals: [{ eventId: "e1", signal: "expansion_signal", at: days(-3) }] }));
    expect(cs.map((c) => c.type)).toEqual(["payment_past_due", "expansion_signal"]);
    expect(cs[0]!.action.params.priority).toBe("high");
    expect(cs[0]!.resource).toBe("billing");
    expect(cs[1]!.evidence[0]).toEqual({ kind: "timeline_event", id: "e1", label: "Expansion signal 2026-10-18" });
  });

  it("every candidate has evidence, a dedupe key and a bounded confidence", () => {
    const all = recommendationCandidates(
      base({
        account: { id: "a1", name: "Acme", healthScore: 20, healthState: "at_risk", healthComputedAt: now },
        subscriptions: [{ id: "s1", status: "past_due", termEnd: days(10), arrMinor: 5, currency: "USD" }],
        overdueInvoices: [{ id: "i1", dueAt: days(-1), amountMinor: 5, currency: "USD" }],
        onboarding: { trials: [{ id: "p1", trialEndsAt: days(1) }], activated: false, stalledSignals: [{ id: "g1", trigger: "login_no_value", firedAt: days(-1) }] },
        tickets: [1, 2, 3].map((i) => ({ id: `t${i}`, title: "T", priority: "p2", severity: "high", breachedClockIds: [`c${i}`] })),
        signals: [{ eventId: "e1", signal: "expansion_signal", at: days(-1) }],
      })
    );
    expect(new Set(all.map((c) => c.type)).size).toBe(7);
    for (const c of all) {
      expect(c.evidence.length).toBeGreaterThan(0);
      expect(c.dedupeKey).toMatch(new RegExp(`^${c.type}:`));
      expect(c.confidence).toBeGreaterThanOrEqual(0.3);
      expect(c.confidence).toBeLessThanOrEqual(0.95);
    }
    expect(new Set(all.map((c) => c.dedupeKey)).size).toBe(all.length);
  });

  const atRisk = { id: "a1", name: "Acme", healthScore: 30, healthState: "at_risk", healthComputedAt: now };
  const renewal = [{ id: "s1", status: "active", termEnd: days(30), arrMinor: 1_200_000, currency: "INR" }];

  it("timeline: no call, email or meeting in 30 days adds the last touch as evidence and raises confidence", () => {
    const fresh = recommendationCandidates(base({ account: atRisk, subscriptions: renewal, lastTouch: { id: "tl1", type: "call", at: days(-5) } }))[0]!;
    const stale = recommendationCandidates(base({ account: atRisk, subscriptions: renewal, lastTouch: { id: "tl1", type: "meeting", at: days(-45) } }))[0]!;
    const never = recommendationCandidates(base({ account: atRisk, subscriptions: renewal, lastTouch: null }))[0]!;
    expect(fresh.evidence.map((e) => e.kind)).toEqual(["subscription", "health_score"]);
    expect(stale.evidence[2]).toEqual({ kind: "timeline_event", id: "tl1", label: "Last meeting 45 days ago (2026-09-06)" });
    expect(stale.rationale).toContain("The last meeting was 45 days ago.");
    expect(stale.confidence).toBeGreaterThan(fresh.confidence);
    expect(never.rationale).toContain("No call, email or meeting is on the timeline.");
    expect(never.evidence.map((e) => e.kind)).toEqual(["subscription", "health_score"]);
  });

  it("usage: high usage and low credits on an activated account; not before activation or with credits left", () => {
    const usage = [{ workspaceId: "w1", balance: 100, granted: 1000, consumed30d: 900, lastConsumeId: "ct1" }];
    const onboarding = { trials: [], activated: true, stalledSignals: [] };
    const [c] = recommendationCandidates(base({ onboarding, usage }));
    expect(c).toMatchObject({ type: "credits_running_low", resource: "crm", action: { kind: "create_task", params: { assign_to: "account_owner", priority: "medium" } }, dedupeKey: "credits_running_low:w1" });
    expect(c!.evidence).toEqual([{ kind: "credit_ledger", id: "ct1", label: "900 credits used in 30 days; 100 of 1,000 left" }]);
    expect(types(base({ onboarding: { ...onboarding, activated: false }, usage }))).toEqual([]);
    expect(types(base({ onboarding, usage: [{ ...usage[0]!, balance: 500 }] }))).toEqual([]);
    expect(types(base({ onboarding, usage: [{ ...usage[0]!, consumed30d: 0, lastConsumeId: null }] }))).toEqual([]);
  });

  it("playbooks: a playbook already running on the account is not suggested again", () => {
    const ctx = base({ account: atRisk, subscriptions: renewal, tickets: [1, 2, 3].map((i) => ({ id: `t${i}`, title: "T", priority: "p3", severity: "low", breachedClockIds: [] })) });
    expect(types(ctx)).toEqual(["renewal_risk", "ticket_heavy"]);
    expect(types({ ...ctx, runningPlaybooks: ["cs_renewal_approaching"] })).toEqual(["ticket_heavy"]);
  });
});
