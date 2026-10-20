/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-11 additions).
 *   - Tables touched directly: companies (read; update of the health fields), contacts, activities
 *     (read)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the health model reads the account's relationship signals and writes the Bible's
 *     Success fields (health_score, health_state, renewal_risk) on the account.
 *   - Review date: 2026-10-20
 */
import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { COPS_TRANSITIONS, createCopsEvent, parseCopsEvent, type HEALTH_SIGNALS } from "@skout/shared";
import { createLogger } from "@skout/observability";
import { HttpError } from "../utils/http.js";
import { runLifecycleTransition } from "./cops-lifecycle.service.js";

const { creditTransactions, companies, contacts, activities, copsOnboardingInstances, engineeringTickets, subscriptions, deals, paymentRequests, copsHealthScores, copsHealthModels, copsLifecycleStates, copsOutbox } = schema;
const log = createLogger("cops-health");

export const HEALTH_DIMENSIONS = ["adoption", "relationship", "support", "commercial", "payment"] as const;
export type HealthDimension = (typeof HEALTH_DIMENSIONS)[number];
export type HealthState = "healthy" | "watch" | "at_risk";
export type HealthSignal = (typeof HEALTH_SIGNALS)[number];

/** COPS-11 health model (Bible p.49: transparent, configurable). Each change is a new version. */
export interface HealthModel {
  version: number;
  weights: Record<HealthDimension, number>;
  thresholds: { healthy: number; atRisk: number };
  /** Days of silence before relationship points are lost, and the renewal window. */
  params: { quietDays: number; renewalWindowDays: number; ticketHeavyOpen: number };
}

export const DEFAULT_HEALTH_MODEL: HealthModel = {
  version: 0,
  weights: { adoption: 20, relationship: 20, support: 20, commercial: 20, payment: 20 },
  thresholds: { healthy: 70, atRisk: 40 },
  params: { quietDays: 21, renewalWindowDays: 90, ticketHeavyOpen: 3 },
};

/** One contributing factor: what was seen, what it cost or gave, and why, in plain words. */
export interface HealthFactor {
  dimension: HealthDimension;
  key: string;
  /** Leading: actionable now. Lagging: an outcome that already happened (Bible p.49). */
  kind: "leading" | "lagging";
  value: number | string | null;
  points: number;
  reason: string;
}

export interface HealthInputs {
  activationPct: number | null;
  firstLoginAt: Date | null;
  activatedAt: Date | null;
  lastActivityAt: Date | null;
  meetings30d: number;
  engagedContacts90d: number;
  openTickets: number;
  highOpenTickets: number;
  tickets90d: number;
  renewalAt: Date | null;
  subscriptionStatus: string | null;
  failedPayments: number;
  /** Credits the customer's workspace used in the last 30 days and the 30 before (COPS-04 ledger). */
  credits30d?: number;
  creditsPrev30d?: number;
}

export interface HealthResult {
  score: number;
  state: HealthState;
  renewalRisk: "low" | "medium" | "high";
  dimensions: Record<HealthDimension, { score: number; weight: number }>;
  factors: HealthFactor[];
  signals: { signal: HealthSignal; evidence: { factor: string; reason: string }[] }[];
}

const DAY = 86_400_000;
const daysBetween = (a: Date, b: Date) => Math.floor((a.getTime() - b.getTime()) / DAY);

/**
 * The score, pure: every point a dimension loses is a factor with its reason, so the breakdown
 * always adds up to the score. A dimension starts at 100; the overall score is the weighted mean.
 */
export function computeHealth(input: HealthInputs, model: HealthModel, now: Date): HealthResult {
  const factors: HealthFactor[] = [];
  const add = (f: HealthFactor) => factors.push(f);
  const p = model.params;

  // Adoption
  if (input.activationPct === null) {
    add({ dimension: "adoption", key: "activation", kind: "lagging", value: null, points: 0, reason: "No onboarding record yet" });
  } else {
    const lost = Math.round((100 - input.activationPct) * 0.6);
    add({ dimension: "adoption", key: "activation", kind: "lagging", value: input.activationPct, points: -lost, reason: `Activation at ${input.activationPct}%` });
    if (!input.firstLoginAt) add({ dimension: "adoption", key: "first_login", kind: "leading", value: null, points: -40, reason: "Nobody has signed in yet" });
  }
  if (input.credits30d !== undefined) {
    const cur = input.credits30d;
    const prev = input.creditsPrev30d ?? 0;
    if (prev > 0 && cur < prev / 2) {
      add({ dimension: "adoption", key: "usage_trend", kind: "leading", value: cur, points: -20, reason: `Credit use down ${Math.round((1 - cur / prev) * 100)}% on the 30 days before (${cur} vs ${prev})` });
    } else if (cur === 0 && input.activatedAt) {
      add({ dimension: "adoption", key: "usage_trend", kind: "leading", value: 0, points: -15, reason: "No credits used in 30 days" });
    } else {
      add({ dimension: "adoption", key: "usage_trend", kind: "leading", value: cur, points: 0, reason: `${cur} credits used in 30 days` });
    }
  }

  // Relationship
  if (!input.lastActivityAt) {
    add({ dimension: "relationship", key: "last_activity", kind: "leading", value: null, points: -50, reason: "No recorded activity with the account" });
  } else {
    const quiet = daysBetween(now, input.lastActivityAt);
    const lost = quiet > p.quietDays ? Math.min(60, (quiet - p.quietDays) * 3) : 0;
    add({ dimension: "relationship", key: "last_activity", kind: "leading", value: quiet, points: -lost, reason: quiet > p.quietDays ? `Quiet for ${quiet} days` : `Last activity ${quiet} days ago` });
  }
  add({ dimension: "relationship", key: "meetings_30d", kind: "leading", value: input.meetings30d, points: input.meetings30d ? 0 : -20, reason: input.meetings30d ? `${input.meetings30d} meeting(s) in 30 days` : "No meeting in 30 days" });
  add({ dimension: "relationship", key: "engaged_contacts", kind: "lagging", value: input.engagedContacts90d, points: input.engagedContacts90d >= 2 ? 0 : -15, reason: `${input.engagedContacts90d} contact(s) engaged in 90 days` });

  // Support
  add({ dimension: "support", key: "open_tickets", kind: "leading", value: input.openTickets, points: -Math.min(45, input.openTickets * 15), reason: `${input.openTickets} open ticket(s)` });
  if (input.highOpenTickets) add({ dimension: "support", key: "high_severity", kind: "leading", value: input.highOpenTickets, points: -25, reason: `${input.highOpenTickets} open high or critical ticket(s)` });
  add({ dimension: "support", key: "tickets_90d", kind: "lagging", value: input.tickets90d, points: input.tickets90d > 5 ? -20 : 0, reason: `${input.tickets90d} ticket(s) in 90 days` });

  // Commercial
  let renewalRisk: HealthResult["renewalRisk"] = "low";
  if (!input.renewalAt) {
    add({ dimension: "commercial", key: "renewal", kind: "leading", value: null, points: 0, reason: "No subscription term on record" });
  } else {
    const days = daysBetween(input.renewalAt, now);
    const near = days <= p.renewalWindowDays;
    add({ dimension: "commercial", key: "renewal", kind: "leading", value: days, points: near ? -15 : 0, reason: days < 0 ? `Renewal ${-days} days overdue` : `Renewal in ${days} days` });
    if (near) renewalRisk = input.meetings30d === 0 || input.openTickets > 0 ? "high" : "medium";
  }

  // Payment
  const restricted = input.subscriptionStatus && ["past_due", "restricted", "suspended"].includes(input.subscriptionStatus);
  add({ dimension: "payment", key: "subscription_status", kind: "lagging", value: input.subscriptionStatus, points: restricted ? -50 : 0, reason: input.subscriptionStatus ? `Subscription ${input.subscriptionStatus.replace("_", " ")}` : "No subscription" });
  add({ dimension: "payment", key: "failed_payments", kind: "leading", value: input.failedPayments, points: -Math.min(50, input.failedPayments * 25), reason: `${input.failedPayments} failed or expired payment request(s)` });
  if (restricted && renewalRisk !== "high") renewalRisk = "high";

  const dimensions = Object.fromEntries(
    HEALTH_DIMENSIONS.map((d) => {
      const raw = 100 + factors.filter((f) => f.dimension === d).reduce((s, f) => s + f.points, 0);
      return [d, { score: Math.max(0, Math.min(100, raw)), weight: model.weights[d] ?? 0 }];
    })
  ) as HealthResult["dimensions"];
  const totalWeight = HEALTH_DIMENSIONS.reduce((s, d) => s + dimensions[d].weight, 0) || 1;
  const score = Math.round(HEALTH_DIMENSIONS.reduce((s, d) => s + dimensions[d].score * dimensions[d].weight, 0) / totalWeight);
  const state: HealthState = score >= model.thresholds.healthy ? "healthy" : score < model.thresholds.atRisk ? "at_risk" : "watch";

  const evidence = (keys: string[]) => factors.filter((f) => keys.includes(f.key) && f.points < 0).map((f) => ({ factor: f.key, reason: f.reason }));
  const signals: HealthResult["signals"] = [];
  if (input.activatedAt && dimensions.adoption.score < 50) signals.push({ signal: "low_adoption", evidence: evidence(["activation", "first_login"]) });
  if (input.openTickets >= p.ticketHeavyOpen || input.highOpenTickets > 0) signals.push({ signal: "ticket_heavy", evidence: evidence(["open_tickets", "high_severity", "tickets_90d"]) });
  if (input.renewalAt && daysBetween(input.renewalAt, now) <= p.renewalWindowDays) {
    signals.push({ signal: "renewal_approaching", evidence: [{ factor: "renewal", reason: factors.find((f) => f.key === "renewal")!.reason }] });
  }
  return { score, state, renewalRisk, dimensions, factors, signals };
}

/** The workspace's live model: its latest version, or the defaults. */
export async function getHealthModel(db: Db, workspaceId: string): Promise<HealthModel> {
  const [row] = await db.select().from(copsHealthModels).where(eq(copsHealthModels.workspaceId, workspaceId)).orderBy(desc(copsHealthModels.version)).limit(1);
  return row ? { ...DEFAULT_HEALTH_MODEL, ...(row.config as Partial<HealthModel>), version: row.version } : DEFAULT_HEALTH_MODEL;
}

/** Saves a new model version (weights, thresholds, params); the caller audits it. */
export async function saveHealthModel(db: Db, workspaceId: string, patch: Partial<Omit<HealthModel, "version">>, actorId: string | null) {
  return db.transaction(async (tx) => {
    const current = await getHealthModel(tx as unknown as Db, workspaceId);
    const next: HealthModel = {
      version: current.version + 1,
      weights: { ...current.weights, ...patch.weights },
      thresholds: { ...current.thresholds, ...patch.thresholds },
      params: { ...current.params, ...patch.params },
    };
    if (next.thresholds.atRisk >= next.thresholds.healthy) throw new HttpError("health_thresholds_invalid", 422);
    if (HEALTH_DIMENSIONS.every((d) => !next.weights[d])) throw new HttpError("health_weights_invalid", 422);
    const { version, ...config } = next;
    await tx.insert(copsHealthModels).values({ workspaceId, version, config, createdBy: actorId });
    return next;
  });
}

/** What the model reads for one account, from the records COPS-02 to COPS-08 already keep. */
export async function gatherHealthInputs(db: Db, workspaceId: string, accountId: string, now: Date): Promise<HealthInputs> {
  const since = (days: number) => new Date(now.getTime() - days * DAY);
  const [inst] = await db
    .select({ activationPct: copsOnboardingInstances.activationPct, firstLoginAt: copsOnboardingInstances.firstLoginAt, activatedAt: copsOnboardingInstances.activatedAt, customerWorkspaceId: copsOnboardingInstances.customerWorkspaceId })
    .from(copsOnboardingInstances)
    .where(and(eq(copsOnboardingInstances.workspaceId, workspaceId), eq(copsOnboardingInstances.accountId, accountId)))
    .orderBy(desc(copsOnboardingInstances.createdAt))
    .limit(1);
  const contactIds = (await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.companyId, accountId)))).map((c) => c.id);
  const entityIds = [accountId, ...contactIds];
  const onAccount = and(eq(activities.workspaceId, workspaceId), inArray(activities.entityId, entityIds));
  const [act] = await db
    .select({
      last: sql<Date | null>`max(${activities.occurredAt})`,
      meetings: sql<number>`count(*) filter (where ${activities.activityType} = 'meeting' and ${activities.occurredAt} >= ${since(30).toISOString()}::timestamptz)::int`,
      engaged: sql<number>`count(distinct ${activities.entityId}) filter (where ${activities.entityType} = 'contact' and ${activities.occurredAt} >= ${since(90).toISOString()}::timestamptz)::int`,
    })
    .from(activities)
    .where(onAccount);
  const [tk] = await db
    .select({
      open: sql<number>`count(*) filter (where ${engineeringTickets.status} not in ('resolved','verified','closed'))::int`,
      high: sql<number>`count(*) filter (where ${engineeringTickets.status} not in ('resolved','verified','closed') and ${engineeringTickets.severity} in ('high','critical'))::int`,
      recent: sql<number>`count(*) filter (where ${engineeringTickets.createdAt} >= ${since(90).toISOString()}::timestamptz)::int`,
    })
    .from(engineeringTickets)
    .where(and(eq(engineeringTickets.workspaceId, workspaceId), eq(engineeringTickets.accountId, accountId)));
  const [sub] = await db
    .select({ termEnd: subscriptions.termEnd, status: subscriptions.status })
    .from(subscriptions)
    .where(and(eq(subscriptions.workspaceId, workspaceId), eq(subscriptions.accountId, accountId), sql`${subscriptions.status} <> 'closed'`))
    .orderBy(desc(subscriptions.termEnd))
    .limit(1);
  const [pay] = await db
    .select({ failed: sql<number>`count(*)::int` })
    .from(paymentRequests)
    .innerJoin(deals, eq(paymentRequests.opportunityId, deals.id))
    .where(and(eq(paymentRequests.workspaceId, workspaceId), eq(deals.companyId, accountId), inArray(paymentRequests.status, ["failed", "expired"]), gte(paymentRequests.createdAt, since(90))));
  // The customer's own workspace holds its credit wallet (COPS-04); usage is its consumption.
  let credits: { cur: number; prev: number } | null = null;
  if (inst?.customerWorkspaceId) {
    const [c] = await db
      .select({
        cur: sql<number>`coalesce(-sum(${creditTransactions.amount}) filter (where ${creditTransactions.createdAt} >= ${since(30).toISOString()}::timestamptz), 0)::int`,
        prev: sql<number>`coalesce(-sum(${creditTransactions.amount}) filter (where ${creditTransactions.createdAt} < ${since(30).toISOString()}::timestamptz), 0)::int`,
      })
      .from(creditTransactions)
      .where(and(eq(creditTransactions.workspaceId, inst.customerWorkspaceId), eq(creditTransactions.kind, "consume"), gte(creditTransactions.createdAt, since(60))));
    credits = { cur: c?.cur ?? 0, prev: c?.prev ?? 0 };
  }
  return {
    credits30d: credits?.cur,
    creditsPrev30d: credits?.prev,
    activationPct: inst ? inst.activationPct : null,
    firstLoginAt: inst?.firstLoginAt ?? null,
    activatedAt: inst?.activatedAt ?? null,
    lastActivityAt: act?.last ? new Date(act.last) : null,
    meetings30d: act?.meetings ?? 0,
    engagedContacts90d: act?.engaged ?? 0,
    openTickets: tk?.open ?? 0,
    highOpenTickets: tk?.high ?? 0,
    tickets90d: tk?.recent ?? 0,
    renewalAt: sub?.termEnd ?? null,
    subscriptionStatus: sub?.status ?? null,
    failedPayments: pay?.failed ?? 0,
  };
}

/** A UUID derived from its parts, so the same signal in the same cycle is always the same event. */
function stableUuid(...parts: string[]): string {
  const h = createHash("sha1").update(parts.join("|")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/** The cycle a signal belongs to: the renewal date for a renewal, otherwise the calendar month. */
export function signalCycle(signal: HealthSignal, now: Date, renewalAt: Date | null): string {
  if (signal === "renewal_approaching" && renewalAt) return `renewal:${renewalAt.toISOString().slice(0, 10)}`;
  return `month:${now.toISOString().slice(0, 7)}`;
}

/**
 * Computes and records one account's health: a history row with the breakdown, the account's
 * Success fields, the health lifecycle state (moving through watch, as the lifecycle requires),
 * and one HealthSignalDetected per signal per cycle. Returns the result and the signals that are new.
 */
export async function recordAccountHealth(db: Db, workspaceId: string, accountId: string, opts: { now?: Date; requestId: string; extraSignals?: HealthResult["signals"] }) {
  const now = opts.now ?? new Date();
  const [account] = await db.select({ id: companies.id }).from(companies).where(and(eq(companies.id, accountId), eq(companies.workspaceId, workspaceId))).limit(1);
  if (!account) throw new HttpError("account_not_found", 404);
  const model = await getHealthModel(db, workspaceId);
  const inputs = await gatherHealthInputs(db, workspaceId, accountId, now);
  const result = computeHealth(inputs, model, now);
  result.signals.push(...(opts.extraSignals ?? []));

  const emitted: HealthSignal[] = [];
  await db.transaction(async (tx) => {
    await tx.insert(copsHealthScores).values({
      workspaceId,
      accountId,
      score: result.score,
      state: result.state,
      renewalRisk: result.renewalRisk,
      dimensions: result.dimensions,
      factors: result.factors,
      modelVersion: model.version,
      computedAt: now,
    });
    await tx
      .update(companies)
      .set({ healthScore: result.score, healthState: result.state, renewalRisk: result.renewalRisk, healthComputedAt: now })
      .where(eq(companies.id, accountId));

    // The health lifecycle moves one allowed step at a time (healthy → watch → at_risk).
    const [cur] = await tx
      .select({ state: copsLifecycleStates.state })
      .from(copsLifecycleStates)
      .where(and(eq(copsLifecycleStates.workspaceId, workspaceId), eq(copsLifecycleStates.dimension, "health"), eq(copsLifecycleStates.entityId, accountId)))
      .limit(1);
    let from = cur?.state ?? "healthy";
    const allowed = COPS_TRANSITIONS.health as Record<string, readonly string[]>;
    for (let i = 0; i < 2 && from !== result.state; i++) {
      const to = allowed[from]?.includes(result.state) ? result.state : "watch";
      await runLifecycleTransition(tx as unknown as Db, {
        workspaceId,
        dimension: "health",
        entityId: accountId,
        to,
        actorId: null,
        actorType: "system",
        source: "health_model",
        reason: `Health score ${result.score}`,
        requestId: opts.requestId,
        occurredAt: now,
      });
      from = to;
    }

    for (const s of result.signals) {
      const cycle = signalCycle(s.signal, now, inputs.renewalAt);
      const event = createCopsEvent({
        eventType: "HealthSignalDetected",
        tenantId: workspaceId,
        aggregateType: "account",
        aggregateId: accountId,
        actor: { type: "system", id: null },
        correlationId: opts.requestId,
        payload: { account_id: accountId, signal: s.signal, cycle, health_score: result.score, evidence: s.evidence },
      });
      const envelope = parseCopsEvent({ ...event, event_id: stableUuid(workspaceId, accountId, s.signal, cycle) });
      const inserted = await tx
        .insert(copsOutbox)
        .values({ id: envelope.event_id, tenantId: workspaceId, eventType: envelope.event_type, aggregateType: "account", aggregateId: accountId, envelope: envelope as unknown as Record<string, unknown> })
        .onConflictDoNothing()
        .returning({ id: copsOutbox.id });
      if (inserted.length) emitted.push(s.signal);
    }
  });
  if (emitted.length) log.info("health signals raised", { accountId, signals: emitted });
  return { ...result, modelVersion: model.version, newSignals: emitted };
}

/** The latest score with its breakdown, or null before the first computation. */
export async function getAccountHealth(db: Db, workspaceId: string, accountId: string) {
  const [row] = await db
    .select()
    .from(copsHealthScores)
    .where(and(eq(copsHealthScores.workspaceId, workspaceId), eq(copsHealthScores.accountId, accountId)))
    .orderBy(desc(copsHealthScores.computedAt))
    .limit(1);
  return row ?? null;
}

/** Score history for trend: newest first, without the breakdown. */
export async function getAccountHealthHistory(db: Db, workspaceId: string, accountId: string, days = 180) {
  return db
    .select({ score: copsHealthScores.score, state: copsHealthScores.state, renewalRisk: copsHealthScores.renewalRisk, dimensions: copsHealthScores.dimensions, computedAt: copsHealthScores.computedAt })
    .from(copsHealthScores)
    .where(and(eq(copsHealthScores.workspaceId, workspaceId), eq(copsHealthScores.accountId, accountId), gte(copsHealthScores.computedAt, new Date(Date.now() - days * DAY))))
    .orderBy(desc(copsHealthScores.computedAt))
    .limit(500);
}

/**
 * COPS-11 sweep of one workspace: recomputes the health of every customer account and every
 * account in onboarding. `expansion` comes from the retention rule (a customer with a new growth
 * signal) and becomes an expansion_signal with that evidence. One account failing never stops
 * the rest. Returns how many were scored and which signals are new.
 */
export async function sweepWorkspaceHealth(
  db: Db,
  workspaceId: string,
  expansion: { companyId: string; signalType: string; detectedAt: string }[],
  now = new Date()
) {
  const ids = await db
    .selectDistinct({ id: companies.id })
    .from(companies)
    .leftJoin(copsOnboardingInstances, and(eq(copsOnboardingInstances.accountId, companies.id), eq(copsOnboardingInstances.workspaceId, workspaceId)))
    .where(and(eq(companies.workspaceId, workspaceId), sql`${companies.deletedAt} is null`, sql`(${companies.status} = 'customer' or ${copsOnboardingInstances.id} is not null)`));
  const byAccount = new Map(expansion.map((e) => [e.companyId, e]));
  let scored = 0;
  const raised: { accountId: string; signals: HealthSignal[] }[] = [];
  for (const { id } of ids) {
    const exp = byAccount.get(id);
    try {
      const r = await recordAccountHealth(db, workspaceId, id, {
        now,
        requestId: crypto.randomUUID(),
        extraSignals: exp
          ? [{ signal: "expansion_signal", evidence: [{ factor: "expansion", reason: `New ${exp.signalType.replace(/_/g, " ")} signal on ${exp.detectedAt.slice(0, 10)}` }] }]
          : [],
      });
      scored++;
      if (r.newSignals.length) raised.push({ accountId: id, signals: r.newSignals });
    } catch (err) {
      log.error("health computation failed for an account", err, { workspaceId, accountId: id });
    }
  }
  return { scored, raised };
}
