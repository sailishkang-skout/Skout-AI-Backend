import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import type { Env } from "../config/env.js";
import { computeCroRollup, type CroRollup } from "./cro-summary.service.js";

const { modelDecisionEvents, prospectScores, prospectActivations, inboxThreads, inboxMessages } = schema;

export type DecisionOutcome = "accepted" | "overridden";

export interface RecordDecisionEventInput {
  workspaceId: string;
  surface: string;
  suggestedValue?: string | null;
  outcome: DecisionOutcome;
  confidence?: number | null;
  metadata?: Record<string, unknown>;
}

/** Logs one AI-decision outcome — the one signal existing tables don't retain (e.g.
 * inbox_threads clears suggestedTag once a manual review resolves it). */
export async function recordDecisionEvent(db: Db, input: RecordDecisionEventInput): Promise<void> {
  await db.insert(modelDecisionEvents).values({
    workspaceId: input.workspaceId,
    surface: input.surface,
    suggestedValue: input.suggestedValue ?? null,
    outcome: input.outcome,
    confidence: input.confidence ?? null,
    metadata: input.metadata ?? {},
  });
}

export interface AcceptanceStats {
  surface: string;
  total: number;
  accepted: number;
  overridden: number;
  /** accepted / total — how often a human went along with the AI's suggestion. */
  actionAcceptanceRate: number;
  /** overridden / total — how often a human changed the AI's suggestion. Always 1 - actionAcceptanceRate;
   * tracked as its own named figure because the Ask names it separately. */
  overrideRate: number;
}

async function acceptanceStatsFor(db: Db, workspaceId: string, surface: string): Promise<AcceptanceStats> {
  const rows = await db
    .select({ outcome: modelDecisionEvents.outcome, count: sql<number>`count(*)` })
    .from(modelDecisionEvents)
    .where(scopedTo(modelDecisionEvents, workspaceId, eq(modelDecisionEvents.surface, surface)))
    .groupBy(modelDecisionEvents.outcome);

  const accepted = Number(rows.find((r) => r.outcome === "accepted")?.count ?? 0);
  const overridden = Number(rows.find((r) => r.outcome === "overridden")?.count ?? 0);
  const total = accepted + overridden;

  return {
    surface,
    total,
    accepted,
    overridden,
    actionAcceptanceRate: total > 0 ? accepted / total : 0,
    overrideRate: total > 0 ? overridden / total : 0,
  };
}

/** 8.15 Ask — "action acceptance": how often a human accepted the AI's suggestion outright. */
export async function computeActionAcceptance(db: Db, workspaceId: string): Promise<AcceptanceStats> {
  return acceptanceStatsFor(db, workspaceId, "reply_classification");
}

/** 8.15 Ask — "override rate": how often a human changed the AI's suggestion. Same event
 * source as computeActionAcceptance — named separately because the Ask names it separately. */
export async function computeOverrideRate(db: Db, workspaceId: string): Promise<AcceptanceStats> {
  return acceptanceStatsFor(db, workspaceId, "reply_classification");
}

async function repliedProspectIds(db: Db, workspaceId: string, prospectIds: string[]): Promise<Set<string>> {
  if (prospectIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ prospectId: inboxThreads.prospectId })
    .from(inboxThreads)
    .innerJoin(inboxMessages, eq(inboxMessages.threadId, inboxThreads.id))
    .where(
      scopedTo(inboxThreads, workspaceId, eq(inboxMessages.direction, "inbound"), inArray(inboxThreads.prospectId, prospectIds))
    );
  return new Set(rows.map((r) => r.prospectId).filter((id): id is string => id != null));
}

export interface CalibrationBucket {
  bucket: string;
  count: number;
  repliedCount: number;
  actualReplyRate: number;
}

const CALIBRATION_BUCKETS = [
  { label: "0-20", min: 0, max: 20 },
  { label: "20-40", min: 20, max: 40 },
  { label: "40-60", min: 40, max: 60 },
  { label: "60-80", min: 60, max: 80 },
  { label: "80-100", min: 80, max: 101 },
];

/** 8.15 Ask — "calibration": do higher AI scores actually correlate with higher real-world
 * reply rates? Buckets every scored prospect by score and compares against the real reply
 * rate observed for that bucket — a reliability check, not a self-reported confidence number. */
export async function computeCalibration(db: Db, workspaceId: string): Promise<CalibrationBucket[]> {
  const scored = await db
    .select({ prospectId: prospectScores.prospectId, score: prospectScores.score })
    .from(prospectScores)
    .where(scopedTo(prospectScores, workspaceId));

  const replied = await repliedProspectIds(db, workspaceId, scored.map((s) => s.prospectId));

  return CALIBRATION_BUCKETS.map(({ label, min, max }) => {
    const inBucket = scored.filter((s) => s.score >= min && s.score < max);
    const repliedCount = inBucket.filter((s) => replied.has(s.prospectId)).length;
    return {
      bucket: label,
      count: inBucket.length,
      repliedCount,
      actualReplyRate: inBucket.length > 0 ? repliedCount / inBucket.length : 0,
    };
  });
}

export interface PrecisionStats {
  /** Prospects the model marked "ready" (its highest-confidence outreach tier). */
  readyCount: number;
  readyAndReplied: number;
  /** readyAndReplied / readyCount — of what the model called ready, how much actually replied. */
  precision: number;
}

/** 8.15 Ask — "precision": of the accounts the model flagged as its top tier ("ready"), what
 * fraction actually replied. */
export async function computePrecision(db: Db, workspaceId: string): Promise<PrecisionStats> {
  const ready = await db
    .select({ prospectId: prospectScores.prospectId })
    .from(prospectScores)
    .where(scopedTo(prospectScores, workspaceId, eq(prospectScores.priority, "ready")));

  const replied = await repliedProspectIds(db, workspaceId, ready.map((r) => r.prospectId));
  const readyAndReplied = ready.filter((r) => replied.has(r.prospectId)).length;

  return {
    readyCount: ready.length,
    readyAndReplied,
    precision: ready.length > 0 ? readyAndReplied / ready.length : 0,
  };
}

export interface FairnessDriftReport {
  temporal: { olderAvgScore: number; newerAvgScore: number; delta: number; sampleSize: number };
  byIndustry: { industry: string; avgScore: number; count: number }[];
}

/** 8.15 Ask — "fairness/drift": is the model scoring one time period or one segment
 * systematically differently from another? Splits scored prospects by scoredAt (older vs newer
 * half) for temporal drift, and by the activation snapshot's industry for a segment check —
 * both real, computed splits, not a fabricated bias score. */
export async function computeFairnessDrift(db: Db, workspaceId: string): Promise<FairnessDriftReport> {
  const scored = await db
    .select({ prospectId: prospectScores.prospectId, score: prospectScores.score, scoredAt: prospectScores.scoredAt })
    .from(prospectScores)
    .where(scopedTo(prospectScores, workspaceId))
    .orderBy(prospectScores.scoredAt);

  const mid = Math.floor(scored.length / 2);
  const older = scored.slice(0, mid);
  const newer = scored.slice(mid);
  const avg = (rows: typeof scored) => (rows.length > 0 ? rows.reduce((s, r) => s + r.score, 0) / rows.length : 0);
  const olderAvgScore = avg(older);
  const newerAvgScore = avg(newer);

  const activations = await db
    .select({ prospectId: prospectActivations.prospectId, snapshot: prospectActivations.snapshot })
    .from(prospectActivations)
    .where(
      scopedTo(prospectActivations, workspaceId, inArray(prospectActivations.prospectId, scored.map((s) => s.prospectId)))
    );
  const industryByProspect = new Map<string, string>();
  for (const a of activations) {
    const industry = (a.snapshot as Record<string, unknown> | null)?.industry;
    if (typeof industry === "string" && industry) industryByProspect.set(a.prospectId, industry);
  }

  const byIndustryMap = new Map<string, { sum: number; count: number }>();
  for (const s of scored) {
    const industry = industryByProspect.get(s.prospectId);
    if (!industry) continue;
    const entry = byIndustryMap.get(industry) ?? { sum: 0, count: 0 };
    entry.sum += s.score;
    entry.count += 1;
    byIndustryMap.set(industry, entry);
  }

  return {
    temporal: {
      olderAvgScore: Math.round(olderAvgScore * 10) / 10,
      newerAvgScore: Math.round(newerAvgScore * 10) / 10,
      delta: Math.round((newerAvgScore - olderAvgScore) * 10) / 10,
      sampleSize: scored.length,
    },
    byIndustry: [...byIndustryMap.entries()]
      .map(([industry, { sum, count }]) => ({ industry, avgScore: Math.round((sum / count) * 10) / 10, count }))
      .sort((a, b) => b.count - a.count),
  };
}

export interface ModelPerformanceReport {
  precision: PrecisionStats;
  calibration: CalibrationBucket[];
  overrideRate: AcceptanceStats;
  actionAcceptance: AcceptanceStats;
  downstreamOutcome: CroRollup;
  fairnessDrift: FairnessDriftReport;
}

/** 8.15 task 34 — bundles all 6 Ask dimensions (precision, calibration, override rate, action
 * acceptance, downstream outcome, fairness/drift) into one report. */
export async function getModelPerformanceReport(db: Db, config: Env, workspaceId: string): Promise<ModelPerformanceReport> {
  const [precision, calibration, overrideRate, actionAcceptance, downstreamOutcome, fairnessDrift] = await Promise.all([
    computePrecision(db, workspaceId),
    computeCalibration(db, workspaceId),
    computeOverrideRate(db, workspaceId),
    computeActionAcceptance(db, workspaceId),
    computeCroRollup(db, config, workspaceId),
    computeFairnessDrift(db, workspaceId),
  ]);

  return { precision, calibration, overrideRate, actionAcceptance, downstreamOutcome, fairnessDrift };
}
