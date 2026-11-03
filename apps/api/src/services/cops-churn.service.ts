/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-14 addition).
 *   - Tables touched directly: companies (read only: id, name, health_score to list scored accounts)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: churn risk ranks the accounts the health sweep already scored; the same read COPS-11
 *     health and success routes make.
 *   - Review date: 2026-11-03
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { gatherHealthInputs, getAccountHealthHistory, type HealthInputs } from "./cops-health.service.js";

/**
 * COPS-14 predictive renewal/churn risk. A transparent scoring model, not a trained one: Skout has
 * no churn history to fit yet. Each signal adds a fixed amount to a log-odds score, so every
 * prediction lists exactly which signals raised or lowered it. The model version is returned with
 * each prediction; when real churn outcomes exist, a fitted model can replace these weights under a
 * new version without changing the response.
 */
export const CHURN_MODEL_VERSION = "churn-explainable-v1";
const BASE_LOG_ODDS = -2.2;
const DAY = 86_400_000;

export interface ChurnFactor {
  key: string;
  label: string;
  /** Log-odds added; positive raises the risk. */
  contribution: number;
  value: number | string | null;
}
export interface ChurnPrediction {
  probability: number;
  band: "low" | "medium" | "high";
  model_version: string;
  factors: ChurnFactor[];
}

/** Points per 30 days from a least-squares line over the score history (newest first in, any order works). */
export function scoreSlopePer30d(history: { score: number; computedAt: Date }[]): number | null {
  if (history.length < 2) return null;
  const t0 = Math.min(...history.map((h) => h.computedAt.getTime()));
  const xs = history.map((h) => (h.computedAt.getTime() - t0) / (30 * DAY));
  const ys = history.map((h) => h.score);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (den === 0) return null;
  return xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0) / den;
}

export function predictChurn(input: HealthInputs, history: { score: number; computedAt: Date }[], now: Date): ChurnPrediction {
  const factors: ChurnFactor[] = [];
  const add = (key: string, label: string, contribution: number, value: ChurnFactor["value"]) => {
    if (contribution !== 0) factors.push({ key, label, contribution: Math.round(contribution * 100) / 100, value });
  };

  const latest = history.length ? [...history].sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime())[0]!.score : null;
  if (latest !== null) add("health_score", `Health score is ${latest}`, Math.max(-1.2, Math.min(1.6, (70 - latest) * 0.04)), latest);

  const slope = scoreSlopePer30d(history.filter((h) => now.getTime() - h.computedAt.getTime() <= 90 * DAY));
  if (slope !== null && Math.abs(slope) >= 3) {
    add("health_trend", slope < 0 ? `Health falling ${Math.round(-slope)} points a month` : `Health rising ${Math.round(slope)} points a month`, Math.max(-0.8, Math.min(1.2, -slope * 0.06)), Math.round(slope * 10) / 10);
  }

  const cur = input.credits30d ?? null;
  const prev = input.creditsPrev30d ?? null;
  if (cur === 0 && (prev ?? 0) > 0) add("usage_stopped", "Product use stopped in the last 30 days", 1.2, 0);
  else if (cur !== null && prev && cur < prev * 0.5) add("usage_drop", `Product use down ${Math.round((1 - cur / prev) * 100)}% month on month`, 0.9, cur);

  if (input.lastActivityAt) {
    const quiet = Math.floor((now.getTime() - input.lastActivityAt.getTime()) / DAY);
    if (quiet > 45) add("quiet", `No contact for ${quiet} days`, 1.1, quiet);
    else if (quiet > 21) add("quiet", `No contact for ${quiet} days`, 0.6, quiet);
  } else {
    add("quiet", "No recorded contact with the customer", 0.6, null);
  }

  if (input.highOpenTickets > 0) add("severe_tickets", `${input.highOpenTickets} high-severity ticket(s) open`, Math.min(3, input.highOpenTickets) * 0.5, input.highOpenTickets);
  if (input.failedPayments > 0) add("failed_payments", `${input.failedPayments} failed payment(s)`, Math.min(3, input.failedPayments) * 0.7, input.failedPayments);
  if (input.subscriptionStatus && ["past_due", "suspended", "unpaid", "canceled", "cancelled"].includes(input.subscriptionStatus)) {
    add("subscription", `Subscription is ${input.subscriptionStatus.replace("_", " ")}`, 1.0, input.subscriptionStatus);
  }
  if (input.activationPct !== null && input.activationPct < 50) add("low_activation", `Only ${input.activationPct}% activated`, 0.5, input.activationPct);

  if (input.renewalAt) {
    const toRenewal = Math.floor((input.renewalAt.getTime() - now.getTime()) / DAY);
    if (toRenewal >= 0 && toRenewal <= 90 && input.engagedContacts90d === 0) add("renewal_unengaged", `Renews in ${toRenewal} days with no engaged contact`, 0.7, toRenewal);
  }
  if (input.engagedContacts90d >= 3) add("engaged", `${input.engagedContacts90d} contacts engaged in 90 days`, -0.5, input.engagedContacts90d);
  if (input.meetings30d > 0) add("meetings", `${input.meetings30d} meeting(s) in 30 days`, -0.3, input.meetings30d);

  const logOdds = BASE_LOG_ODDS + factors.reduce((a, f) => a + f.contribution, 0);
  const probability = Math.round((1 / (1 + Math.exp(-logOdds))) * 1000) / 1000;
  factors.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return { probability, band: probability >= 0.5 ? "high" : probability >= 0.2 ? "medium" : "low", model_version: CHURN_MODEL_VERSION, factors };
}

export async function predictAccountChurn(db: Db, workspaceId: string, accountId: string, now = new Date()) {
  const [inputs, history] = await Promise.all([gatherHealthInputs(db, workspaceId, accountId, now), getAccountHealthHistory(db, workspaceId, accountId, 180)]);
  return predictChurn(inputs, history.map((h) => ({ score: h.score, computedAt: h.computedAt })), now);
}

/** Highest-risk scored accounts first. Only accounts that already have a health score are ranked. */
export async function listChurnRisk(db: Db, workspaceId: string, limit = 25) {
  const { companies } = schema;
  const accounts = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.workspaceId, workspaceId), isNotNull(companies.healthScore)))
    .orderBy(desc(companies.updatedAt))
    .limit(200);
  const now = new Date();
  const rows = [];
  for (const a of accounts) {
    const p = await predictAccountChurn(db, workspaceId, a.id, now);
    rows.push({ account_id: a.id, name: a.name, ...p, factors: p.factors.slice(0, 3) });
  }
  return rows.sort((x, y) => y.probability - x.probability).slice(0, limit);
}
