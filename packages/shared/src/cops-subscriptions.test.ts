import { describe, expect, it } from "vitest";
import { COMMERCIAL_POLICY_DEFAULTS } from "./cops-commercial-policy.js";
import { addMonthsUtc, nextDunningStep, periodAmountMinor, periodsStarted, subscriptionPeriod, subscriptionStatusFor } from "./cops-subscriptions.js";

const at = (iso: string) => new Date(iso);
const iso = (d: Date | undefined) => d?.toISOString();
const policy = COMMERCIAL_POLICY_DEFAULTS.dunning_policy;

describe("COPS-08 billing periods", () => {
  it("adds months in UTC and keeps the end of a short month", () => {
    expect(iso(addMonthsUtc(at("2026-10-13T10:00:00Z"), 1))).toBe("2026-11-13T10:00:00.000Z");
    expect(iso(addMonthsUtc(at("2026-01-31T00:00:00Z"), 1))).toBe("2026-02-28T00:00:00.000Z");
    expect(iso(addMonthsUtc(at("2026-11-15T00:00:00Z"), 14))).toBe("2028-01-15T00:00:00.000Z");
  });

  it("splits a term into monthly or annual periods and stops when the term is over", () => {
    const start = at("2026-10-13T00:00:00Z");
    expect(subscriptionPeriod(start, "monthly", 12, 0)).toMatchObject({ months: 1, start, end: at("2026-11-13T00:00:00Z") });
    expect(iso(subscriptionPeriod(start, "monthly", 12, 11)?.end)).toBe("2027-10-13T00:00:00.000Z");
    expect(subscriptionPeriod(start, "monthly", 12, 12)).toBeNull();
    expect(subscriptionPeriod(start, "annual", 12, 0)).toMatchObject({ months: 12, end: at("2027-10-13T00:00:00Z") });
    expect(subscriptionPeriod(start, "annual", 12, 1)).toBeNull();
  });

  it("makes the last period shorter when the term is not a whole number of periods", () => {
    const start = at("2026-10-13T00:00:00Z");
    expect(subscriptionPeriod(start, "annual", 18, 1)).toMatchObject({ months: 6, start: at("2027-10-13T00:00:00Z"), end: at("2028-04-13T00:00:00Z") });
    expect(subscriptionPeriod(start, "annual", 18, 2)).toBeNull();
  });

  it("lists the periods that have started, and none before the term", () => {
    const start = at("2026-10-13T00:00:00Z");
    expect(periodsStarted(start, "monthly", 12, at("2026-10-12T00:00:00Z"))).toHaveLength(0);
    expect(periodsStarted(start, "monthly", 12, at("2026-10-13T00:00:00Z"))).toHaveLength(1);
    expect(periodsStarted(start, "monthly", 12, at("2026-12-20T00:00:00Z")).map((p) => p.index)).toEqual([0, 1, 2]);
    expect(periodsStarted(start, "monthly", 3, at("2030-01-01T00:00:00Z"))).toHaveLength(3);
  });

  it("charges quantity x price per month x months in the period", () => {
    expect(periodAmountMinor([{ quantity: 10, unit_amount_minor: 7900 }], 12)).toBe(948_000);
    expect(periodAmountMinor([{ quantity: 10, unit_amount_minor: 9480 }], 1)).toBe(94_800);
    expect(periodAmountMinor([{ quantity: 10, unit_amount_minor: 7900 }], 6)).toBe(474_000);
  });
});

describe("COPS-08 subscription status from the oldest unpaid bill", () => {
  const due = at("2026-10-01T00:00:00Z");
  const on = (day: number, billing: "payment_link" | "invoiced" = "payment_link") =>
    subscriptionStatusFor(policy, { billing, oldest_overdue_due_at: due, now: new Date(due.getTime() + day * 86_400_000 + 3_600_000) });

  it("is active when nothing is unpaid or the bill is not due yet: a payment restores access", () => {
    expect(subscriptionStatusFor(policy, { billing: "payment_link", oldest_overdue_due_at: null, now: due })).toEqual({ status: "active", day: null });
    expect(subscriptionStatusFor(policy, { billing: "payment_link", oldest_overdue_due_at: due, now: at("2026-09-30T00:00:00Z") }).status).toBe("active");
  });

  it("counts days from the due date: past due, restricted on day 8, suspended on day 15, closed on day 45", () => {
    expect([0, 7, 8, 14, 15, 44, 45].map((d) => on(d).status)).toEqual(["past_due", "past_due", "restricted", "restricted", "suspended", "suspended", "closed"]);
    expect(on(8).day).toBe(8);
  });

  it("an invoiced account stays past due until Finance acts", () => {
    expect(on(30, "invoiced")).toEqual({ status: "past_due", day: 30 });
  });

  it("tells Finance the next automatic step and its date, or that there is none", () => {
    expect(nextDunningStep(policy, "payment_link", due, 3)).toEqual({ status: "restricted", at: at("2026-10-09T00:00:00Z") });
    expect(nextDunningStep(policy, "payment_link", due, 20)).toEqual({ status: "closed", at: at("2026-11-15T00:00:00Z") });
    expect(nextDunningStep(policy, "payment_link", due, 60)).toBeNull();
    expect(nextDunningStep(policy, "invoiced", due, 3)).toBeNull();
  });
});
