import { and, eq, ne, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { HttpError } from "../utils/http.js";
import { buildEntitlementsService } from "./entitlements.service.js";

/**
 * COPS-14 advanced billing: metered usage and plan limits (pricing handoff, 23 Oct 2026).
 * - AI actions are counted per calendar month (UTC) with an atomic upsert, warned at 80% and
 *   stopped at 100% of the plan.
 * - Connected identities (Unipile LinkedIn/WhatsApp accounts) are capped at the plan's count plus
 *   any add-on identities, so Unipile's peak-account bill cannot grow past what is paid for.
 * Plan and limits are entitlements, so finance can override them per workspace without a deploy.
 */
const { copsUsageCounters, linkedinAccounts } = schema;

export type PlanCode = "full" | "multichannel";
export const PLAN_LIMITS: Record<PlanCode, { ai_actions: number; identities: number; contacts: number; sends: number }> = {
  full: { ai_actions: 1_000, identities: 1, contacts: 2_000, sends: 5_000 },
  multichannel: { ai_actions: 5_000, identities: 2, contacts: 10_000, sends: 25_000 },
};
export const WARN_AT = 0.8;

export const currentPeriod = (now = new Date()) => now.toISOString().slice(0, 7);

/** A usage decision, pure so it can be tested. */
export function usageVerdict(used: number, adding: number, limit: number): { allowed: boolean; warn: boolean; remaining: number } {
  const after = used + adding;
  if (after > limit) return { allowed: false, warn: true, remaining: Math.max(0, limit - used) };
  return { allowed: true, warn: after >= limit * WARN_AT, remaining: limit - after };
}

export async function planLimits(db: Db, workspaceId: string) {
  const ent = buildEntitlementsService(db)!;
  const plan = await ent.getValueOr<string>(workspaceId, "plan.code", "full");
  const base = PLAN_LIMITS[(plan === "multichannel" ? "multichannel" : "full") as PlanCode];
  const [ai, extraIdentities] = await Promise.all([
    ent.getValueOr<number>(workspaceId, "limits.ai_actions_monthly", base.ai_actions),
    ent.getValueOr<number>(workspaceId, "limits.extra_identities", 0),
  ]);
  return { plan: plan === "multichannel" ? "multichannel" : "full", ai_actions: Number(ai) || base.ai_actions, identities: base.identities + (Number(extraIdentities) || 0), contacts: base.contacts, sends: base.sends };
}

async function readCounter(db: Db, workspaceId: string, metric: string, period: string): Promise<number> {
  const [row] = await db
    .select({ count: copsUsageCounters.count })
    .from(copsUsageCounters)
    .where(and(eq(copsUsageCounters.workspaceId, workspaceId), eq(copsUsageCounters.metric, metric), eq(copsUsageCounters.period, period)))
    .limit(1);
  return row?.count ?? 0;
}

/**
 * Counts one AI action, or refuses it when the month's limit is used up. The increment is a single
 * guarded upsert, so two requests at the limit cannot both pass.
 */
export async function meterAiAction(db: Db, workspaceId: string, now = new Date()): Promise<{ used: number; limit: number; warn: boolean }> {
  const { ai_actions: limit } = await planLimits(db, workspaceId);
  const period = currentPeriod(now);
  const rows = await db.execute(sql`
    INSERT INTO cops_usage_counters (workspace_id, metric, period, count, updated_at)
    VALUES (${workspaceId}, 'ai_actions', ${period}, 1, now())
    ON CONFLICT (workspace_id, metric, period)
    DO UPDATE SET count = cops_usage_counters.count + 1, updated_at = now()
    WHERE cops_usage_counters.count < ${limit}
    RETURNING count`);
  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as { count: number }[];
  if (list.length === 0) {
    throw new HttpError(`This workspace has used all ${limit} AI actions for ${period}. Ask an admin to raise the plan limit.`, 429, { code: "USAGE_LIMIT_REACHED", metric: "ai_actions", limit, period });
  }
  const used = Number(list[0]!.count);
  return { used, limit, warn: usageVerdict(used - 1, 1, limit).warn };
}

/** Gives back one AI action that was counted but never ran (the request was rejected as invalid). */
export async function refundAiAction(db: Db, workspaceId: string, now = new Date()) {
  await db.execute(sql`
    UPDATE cops_usage_counters SET count = count - 1, updated_at = now()
    WHERE workspace_id = ${workspaceId} AND metric = 'ai_actions' AND period = ${currentPeriod(now)} AND count > 0`);
}

/** Refuses a new connected identity beyond the plan. Reconnecting an existing account is free. */
export async function assertIdentityAvailable(db: Db, workspaceId: string, unipileAccountId: string) {
  const { identities } = await planLimits(db, workspaceId);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(linkedinAccounts)
    .where(and(eq(linkedinAccounts.workspaceId, workspaceId), eq(linkedinAccounts.status, "active"), ne(linkedinAccounts.unipileAccountId, unipileAccountId)));
  const used = Number(row?.n ?? 0);
  if (!usageVerdict(used, 1, identities).allowed) {
    throw new HttpError(`Your plan includes ${identities} connected identit${identities === 1 ? "y" : "ies"}. Add an identity to connect another.`, 402, { code: "USAGE_LIMIT_REACHED", metric: "identities", limit: identities });
  }
}

/** The usage page: this month's metered counts against the plan. */
export async function getUsage(db: Db, workspaceId: string, now = new Date()) {
  const limits = await planLimits(db, workspaceId);
  const period = currentPeriod(now);
  const [ai, idRow] = await Promise.all([
    readCounter(db, workspaceId, "ai_actions", period),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(linkedinAccounts)
      .where(and(eq(linkedinAccounts.workspaceId, workspaceId), eq(linkedinAccounts.status, "active"))),
  ]);
  return {
    plan: limits.plan,
    period,
    metrics: [
      { key: "ai_actions", label: "AI actions this month", used: ai, limit: limits.ai_actions },
      { key: "identities", label: "Connected LinkedIn / WhatsApp identities", used: Number(idRow[0]?.n ?? 0), limit: limits.identities },
    ].map((m) => ({ ...m, warn: m.used >= m.limit * WARN_AT })),
  };
}
