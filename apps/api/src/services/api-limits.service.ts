import { and, eq, gte, gt, isNotNull, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { HttpError } from "../utils/http.js";
import type { QuotaKind, QuotaStore } from "../lib/api-quota.js";

const { creditTransactions, creditHolds, workspaceApiSettings } = schema;

/**
 * Public API caps and quotas (PAPI-033, public API PRD CRED-7, RL-5, RL-6).
 * - Caps limit credits: per key per UTC day and month, and per workspace per UTC month (API spend
 *   only). Counted from the ledger plus active holds, checked inside `reserve()` under the wallet lock.
 * - Quotas limit counts: verifications and search results per key per UTC day (see lib/api-quota.ts).
 * Every period resets at UTC midnight / on the 1st of the month (UTC).
 */

export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
export function nextUtcDayStart(now: Date): Date {
  return new Date(utcDayStart(now).getTime() + 86_400_000);
}
export function nextUtcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export interface CreditCaps {
  keyDaily?: number | null;
  keyMonthly?: number | null;
  workspaceMonthly?: number | null;
}

export type CapName = "key_daily" | "key_monthly" | "workspace_monthly";

export class CapReachedError extends HttpError {
  constructor(
    public readonly cap: CapName,
    public readonly limit: number,
    public readonly used: number,
    public readonly resetsAt: Date
  ) {
    super("cap_reached", 429, {
      cap,
      limit,
      used,
      resets_at: resetsAt.toISOString(),
      message: `This request would pass the ${cap.replace("_", " ")} credit cap of ${limit}.`,
    });
    this.name = "CapReachedError";
  }
}

async function spentSince(db: Db, where: ReturnType<typeof and>, since: Date): Promise<number> {
  const [row] = await db
    .select({ spent: sql<number>`coalesce(-sum(${creditTransactions.amount}), 0)::int` })
    .from(creditTransactions)
    .where(and(where, eq(creditTransactions.kind, "consume"), gte(creditTransactions.createdAt, since)));
  return Math.max(0, row?.spent ?? 0);
}

async function heldNow(db: Db, where: ReturnType<typeof and>, now: Date): Promise<number> {
  const [row] = await db
    .select({ held: sql<number>`coalesce(sum(${creditHolds.amount}), 0)::int` })
    .from(creditHolds)
    .where(and(where, eq(creditHolds.status, "held"), gt(creditHolds.expiresAt, now)));
  return row?.held ?? 0;
}

/**
 * Throws CapReachedError when spending `max` more would pass a cap. Counts committed API spend in the
 * current UTC period plus credits held for in-flight requests, so concurrent requests can't jointly
 * overshoot. Call it while holding the workspace wallet lock (reserve does).
 */
export async function assertCreditCaps(
  db: Db,
  input: { workspaceId: string; apiKeyId: string; max: number; caps: CreditCaps },
  now: Date
): Promise<void> {
  const { caps, max } = input;
  const keyLedger = eq(creditTransactions.apiKeyId, input.apiKeyId);
  const keyHolds = and(eq(creditHolds.workspaceId, input.workspaceId), eq(creditHolds.apiKeyId, input.apiKeyId));
  const keyHeld = caps.keyDaily != null || caps.keyMonthly != null ? await heldNow(db, keyHolds, now) : 0;

  if (caps.keyDaily != null) {
    const used = (await spentSince(db, and(keyLedger), utcDayStart(now))) + keyHeld;
    if (used + max > caps.keyDaily) throw new CapReachedError("key_daily", caps.keyDaily, used, nextUtcDayStart(now));
  }
  if (caps.keyMonthly != null) {
    const used = (await spentSince(db, and(keyLedger), utcMonthStart(now))) + keyHeld;
    if (used + max > caps.keyMonthly) throw new CapReachedError("key_monthly", caps.keyMonthly, used, nextUtcMonthStart(now));
  }
  if (caps.workspaceMonthly != null) {
    const spent = await spentSince(
      db,
      and(eq(creditTransactions.workspaceId, input.workspaceId), isNotNull(creditTransactions.apiKeyId)),
      utcMonthStart(now)
    );
    const held = await heldNow(db, and(eq(creditHolds.workspaceId, input.workspaceId), isNotNull(creditHolds.apiKeyId)), now);
    const used = spent + held;
    if (used + max > caps.workspaceMonthly) {
      throw new CapReachedError("workspace_monthly", caps.workspaceMonthly, used, nextUtcMonthStart(now));
    }
  }
}

// --- Limits for one key ------------------------------------------------------

export interface ApiLimitDefaults {
  /** PUBLIC_API_VERIFY_DAILY_QUOTA */
  verifyDailyQuota: number;
  /** PUBLIC_API_SEARCH_DAILY_QUOTA */
  searchDailyQuota: number;
}

export interface KeyLimits {
  caps: CreditCaps;
  verifyDailyQuota: number;
  searchDailyQuota: number;
}

/** The caps and quotas that apply to a key: its own caps, the workspace's settings, then env defaults. */
export async function limitsForKey(
  db: Db,
  defaults: ApiLimitDefaults,
  key: { workspaceId: string; dailyCreditCap: number | null; monthlyCreditCap: number | null }
): Promise<KeyLimits> {
  const [s] = await db
    .select({
      verify: workspaceApiSettings.verifyDailyQuota,
      search: workspaceApiSettings.searchDailyQuota,
      monthly: workspaceApiSettings.monthlyCreditCap,
    })
    .from(workspaceApiSettings)
    .where(eq(workspaceApiSettings.workspaceId, key.workspaceId))
    .limit(1);
  return {
    caps: { keyDaily: key.dailyCreditCap, keyMonthly: key.monthlyCreditCap, workspaceMonthly: s?.monthly ?? null },
    verifyDailyQuota: s?.verify ?? defaults.verifyDailyQuota,
    searchDailyQuota: s?.search ?? defaults.searchDailyQuota,
  };
}

// --- Quotas -------------------------------------------------------------------

export class QuotaReachedError extends HttpError {
  constructor(
    public readonly quota: "verify_daily" | "search_results_daily",
    public readonly limit: number,
    public readonly used: number,
    public readonly resetsAt: Date
  ) {
    super("quota_reached", 429, {
      quota,
      limit,
      used,
      resets_at: resetsAt.toISOString(),
      message: `This key has used its daily ${quota === "verify_daily" ? "verification" : "search result"} quota of ${limit}.`,
    });
    this.name = "QuotaReachedError";
  }
}

/**
 * Takes `units` from a key's daily quota or throws QuotaReachedError (429). A batch counts in full
 * (JOB-1: a 1,000-email batch takes 1,000 verifications up front).
 */
export async function consumeQuota(
  store: QuotaStore,
  kind: QuotaKind,
  keyId: string,
  units: number,
  limits: KeyLimits,
  now = new Date()
): Promise<void> {
  const limit = kind === "verify" ? limits.verifyDailyQuota : limits.searchDailyQuota;
  const r = await store.tryConsume(kind, keyId, units, limit, now);
  if (!r.ok) throw new QuotaReachedError(kind === "verify" ? "verify_daily" : "search_results_daily", limit, r.used, r.resetsAt);
}

// --- Usage (PAPI-061, GET /usage) ------------------------------------------------

export interface LimitUsage {
  limit: number;
  used: number;
  remaining: number;
  resets_at: string;
}

export interface ApiUsage {
  /** API spend (credits charged to API keys), committed only. */
  spent: { key_today: number; key_this_month: number; workspace_api_today: number; workspace_api_this_month: number };
  caps: { key_daily: LimitUsage | null; key_monthly: LimitUsage | null; workspace_monthly: LimitUsage | null };
  quotas: { email_verifications_daily: LimitUsage; search_results_daily: LimitUsage };
}

const limitUsage = (limit: number, used: number, resetsAt: Date): LimitUsage => ({
  limit,
  used,
  remaining: Math.max(0, limit - used),
  resets_at: resetsAt.toISOString(),
});

/**
 * What a key has used against its caps and quotas, and what the workspace spent through the API, in
 * the current UTC day and month. Caps count credits held for in-flight requests too, as the caps
 * themselves do (assertCreditCaps).
 */
export async function apiUsage(
  db: Db,
  store: QuotaStore,
  key: { id: string; workspaceId: string },
  limits: KeyLimits,
  now = new Date()
): Promise<ApiUsage> {
  const keyLedger = and(eq(creditTransactions.apiKeyId, key.id));
  const wsLedger = and(eq(creditTransactions.workspaceId, key.workspaceId), isNotNull(creditTransactions.apiKeyId));
  const [keyToday, keyMonth, wsToday, wsMonth, keyHeld, wsHeld, verifyUsed, searchUsed] = await Promise.all([
    spentSince(db, keyLedger, utcDayStart(now)),
    spentSince(db, keyLedger, utcMonthStart(now)),
    spentSince(db, wsLedger, utcDayStart(now)),
    spentSince(db, wsLedger, utcMonthStart(now)),
    heldNow(db, and(eq(creditHolds.workspaceId, key.workspaceId), eq(creditHolds.apiKeyId, key.id)), now),
    heldNow(db, and(eq(creditHolds.workspaceId, key.workspaceId), isNotNull(creditHolds.apiKeyId)), now),
    store.used("verify", key.id, now),
    store.used("search_results", key.id, now),
  ]);
  const { caps } = limits;
  return {
    spent: { key_today: keyToday, key_this_month: keyMonth, workspace_api_today: wsToday, workspace_api_this_month: wsMonth },
    caps: {
      key_daily: caps.keyDaily != null ? limitUsage(caps.keyDaily, keyToday + keyHeld, nextUtcDayStart(now)) : null,
      key_monthly: caps.keyMonthly != null ? limitUsage(caps.keyMonthly, keyMonth + keyHeld, nextUtcMonthStart(now)) : null,
      workspace_monthly: caps.workspaceMonthly != null ? limitUsage(caps.workspaceMonthly, wsMonth + wsHeld, nextUtcMonthStart(now)) : null,
    },
    quotas: {
      email_verifications_daily: limitUsage(limits.verifyDailyQuota, verifyUsed, nextUtcDayStart(now)),
      search_results_daily: limitUsage(limits.searchDailyQuota, searchUsed, nextUtcDayStart(now)),
    },
  };
}
