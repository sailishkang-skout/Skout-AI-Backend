import { dunningDay, dunningStage, type DunningPolicy } from "./cops-commercial-policy.js";

/**
 * COPS-08 subscription rules with no I/O (Bible p.36): billing periods of a term, what one period
 * costs, and the status a subscription has given its oldest unpaid bill.
 */
export const SUBSCRIPTION_STATUSES = ["active", "past_due", "restricted", "suspended", "closed"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * How a subscription is charged:
 *  - payment_link: a payment link per billing period, with our own failed-payment timeline from the
 *    due date. Works in every currency the provider accepts for links; the fallback where the
 *    provider cannot auto-debit (international cards).
 *  - invoiced: enterprise accounts paying against an invoice. Never suspended automatically.
 *  - provider: the provider charges the card itself (a Razorpay subscription). Not built yet.
 */
export const SUBSCRIPTION_BILLING = ["payment_link", "invoiced", "provider"] as const;
export type SubscriptionBilling = (typeof SUBSCRIPTION_BILLING)[number];

export const SUBSCRIPTION_CADENCES = ["monthly", "annual"] as const;
export type SubscriptionCadence = (typeof SUBSCRIPTION_CADENCES)[number];

/** Same day of a later month in UTC; the 31st becomes the last day of a shorter month. */
export function addMonthsUtc(date: Date, months: number): Date {
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return first;
}

export function cadenceMonths(cadence: SubscriptionCadence): number {
  return cadence === "annual" ? 12 : 1;
}

export interface SubscriptionPeriod {
  index: number;
  start: Date;
  end: Date;
  /** Months billed in this period; the last period of a term can be shorter than the cadence. */
  months: number;
}

/** Billing period `index` (from 0) of a term, or null once the term is over. */
export function subscriptionPeriod(termStart: Date, cadence: SubscriptionCadence, termMonths: number, index: number): SubscriptionPeriod | null {
  const step = cadenceMonths(cadence);
  const offset = index * step;
  if (index < 0 || offset >= termMonths) return null;
  const months = Math.min(step, termMonths - offset);
  return { index, start: addMonthsUtc(termStart, offset), end: addMonthsUtc(termStart, offset + months), months };
}

/** Every period that has started by `now`. Empty before the term starts. */
export function periodsStarted(termStart: Date, cadence: SubscriptionCadence, termMonths: number, now: Date): SubscriptionPeriod[] {
  const out: SubscriptionPeriod[] = [];
  for (let i = 0; ; i++) {
    const period = subscriptionPeriod(termStart, cadence, termMonths, i);
    if (!period || period.start.getTime() > now.getTime()) return out;
    out.push(period);
  }
}

/** What one period costs: each item's quantity x price per month x the months in the period. */
export function periodAmountMinor(items: Array<{ quantity: number; unit_amount_minor: number }>, months: number): number {
  return items.reduce((sum, item) => sum + item.quantity * item.unit_amount_minor * months, 0);
}

/**
 * The status of a subscription from its oldest unpaid bill. Nothing overdue: active, which is how
 * a payment restores access. Otherwise day 0 is the due date of that bill and the dunning policy
 * decides. A closed subscription stays closed; the caller keeps that rule.
 */
export function subscriptionStatusFor(
  policy: DunningPolicy,
  input: { billing: SubscriptionBilling; oldest_overdue_due_at: Date | null; provider_halted?: boolean; now: Date }
): { status: SubscriptionStatus; day: number | null } {
  if (!input.oldest_overdue_due_at || input.oldest_overdue_due_at.getTime() > input.now.getTime()) return { status: "active", day: null };
  const day = dunningDay(input.oldest_overdue_due_at, input.now);
  return { status: dunningStage(policy, { day, provider_halted: Boolean(input.provider_halted), invoiced: input.billing === "invoiced" }), day };
}

/** The next automatic step and when it happens, for the Finance queue. Null when nothing more is automatic. */
export function nextDunningStep(policy: DunningPolicy, billing: SubscriptionBilling, dueAt: Date, day: number): { status: SubscriptionStatus; at: Date } | null {
  if (billing === "invoiced" && !policy.invoiced_accounts_auto_suspend) return null;
  const next = policy.stages.find((s) => s.from_day > day);
  return next ? { status: next.state, at: new Date(dueAt.getTime() + next.from_day * 86_400_000) } : null;
}

// --- amendments ------------------------------------------------------------------------------------

/** Seats in force at a moment: the latest seat amendment already effective then, else the original count. */
export function effectiveSeats(original: number, amendments: Array<{ seats: number | null; effective_at: Date; seq: number }>, at: Date): number {
  const inForce = amendments.filter((a) => a.seats != null && a.effective_at.getTime() <= at.getTime()).sort((a, b) => b.seq - a.seq)[0];
  return inForce?.seats ?? original;
}

/**
 * When a seat change made at `now` starts: the first billing period that begins after `now`. Seat
 * changes are never prorated inside a period. Null when the term has no later period.
 */
export function nextPeriodStart(termStart: Date, cadence: SubscriptionCadence, termMonths: number, now: Date): Date | null {
  for (let i = 0; ; i++) {
    const period = subscriptionPeriod(termStart, cadence, termMonths, i);
    if (!period) return null;
    if (period.start.getTime() > now.getTime()) return period.start;
  }
}
