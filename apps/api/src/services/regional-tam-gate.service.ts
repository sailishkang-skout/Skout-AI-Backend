import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { HttpError } from "../utils/http.js";

const { competitiveWinLossDeals } = schema;

/** §2 / §3 — Regional TAM marketing gate clears at ≥4 recorded win/loss deals. */
export const REGIONAL_TAM_MIN_DEALS = 4;

export type RegionalTamGate = "validated" | "not_validated";

export async function countWinLossDeals(db: Db, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(competitiveWinLossDeals)
    .where(scopedTo(competitiveWinLossDeals, workspaceId));
  return Number(row?.n ?? 0);
}

export async function getRegionalTamGate(db: Db, workspaceId: string): Promise<{
  gate: RegionalTamGate;
  dealsReviewed: number;
  minDeals: number;
}> {
  const dealsReviewed = await countWinLossDeals(db, workspaceId);
  return {
    gate: dealsReviewed >= REGIONAL_TAM_MIN_DEALS ? "validated" : "not_validated",
    dealsReviewed,
    minDeals: REGIONAL_TAM_MIN_DEALS,
  };
}

/**
 * §3 Global-by-model — block marketing/competitive/TAM claims until win/loss validated.
 * `onboarding` / `territory` heuristics may pass with `allowUnvalidated`.
 */
export async function assertRegionalTamValidated(
  db: Db,
  workspaceId: string,
  opts?: { purpose?: string; allowUnvalidatedPurposes?: string[] }
): Promise<{ gate: RegionalTamGate; dealsReviewed: number; minDeals: number }> {
  const status = await getRegionalTamGate(db, workspaceId);
  const allow =
    opts?.allowUnvalidatedPurposes ?? ["onboarding", "territory"];
  if (status.gate === "validated") return status;
  if (opts?.purpose && allow.includes(opts.purpose)) return status;
  throw new HttpError(
    `Regional TAM / global-by-model gate not validated — record ≥${REGIONAL_TAM_MIN_DEALS} win/loss deals (have ${status.dealsReviewed})`,
    422,
    { regionalTamGate: status }
  );
}

export async function seedDemoWinLossDeals(db: Db, workspaceId: string, userId?: string) {
  const existing = await countWinLossDeals(db, workspaceId);
  if (existing >= REGIONAL_TAM_MIN_DEALS) return existing;
  const needed = REGIONAL_TAM_MIN_DEALS - existing;
  const fixtures = [
    { accountName: "Acme SaaS", outcome: "won", competitors: "Outreach", differentiatorCited: "Evidence ledger" },
    { accountName: "Globex", outcome: "lost", competitors: "Apollo", differentiatorCited: "Regional TAM" },
    { accountName: "Initech", outcome: "won", competitors: "ZoomInfo", differentiatorCited: "Identity merge" },
    { accountName: "Umbrella", outcome: "lost", competitors: "Salesloft", differentiatorCited: "Policy Gateway" },
  ];
  for (let i = 0; i < needed; i++) {
    const f = fixtures[i % fixtures.length]!;
    await db.insert(competitiveWinLossDeals).values({
      workspaceId,
      accountName: `${f.accountName} #${existing + i + 1}`,
      outcome: f.outcome,
      competitors: f.competitors,
      differentiatorCited: f.differentiatorCited,
      evidenceOrRegionalMaterial: true,
      notes: "Seeded for §3 global-by-model gate (demo/test)",
      recordedBy: userId,
    });
  }
  return countWinLossDeals(db, workspaceId);
}

/** Re-export for list filters that need deal rows. */
export async function listRecentDeals(db: Db, workspaceId: string, limit = 20) {
  return db
    .select()
    .from(competitiveWinLossDeals)
    .where(scopedTo(competitiveWinLossDeals, workspaceId))
    .orderBy(desc(competitiveWinLossDeals.createdAt))
    .limit(limit);
}
