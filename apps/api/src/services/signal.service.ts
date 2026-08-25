import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import type { TargetAction } from "./activation-rules.service.js";

const { signals, prospectActivations } = schema;

export interface SignalRecord {
  id: string;
  entityType: string;
  entityId: string;
  signalType: string;
  value: Record<string, unknown>;
  confidence: number | null;
  /** When the real-world event happened. Falls back to detectedAt when the producer didn't know it separately. */
  observedAt: string;
  /** When Skout's system detected/ingested this signal — can lag observedAt. */
  detectedAt: string;
  source: string | null;
  provenance: Record<string, unknown>;
  createdAt: string;
  /** Null = never expires. */
  expiresAt: string | null;
  /** Target actions (activation-rules.service.ts's TargetAction) this signal may drive. */
  activationPaths: TargetAction[];
}

function serialize(row: typeof signals.$inferSelect): SignalRecord {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    signalType: row.signalType,
    value: row.value as Record<string, unknown>,
    confidence: row.confidence,
    observedAt: (row.observedAt ?? row.detectedAt).toISOString(),
    detectedAt: row.detectedAt.toISOString(),
    source: row.source,
    provenance: row.provenance as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    activationPaths: (row.activationPaths as TargetAction[] | null) ?? [],
  };
}

/** A signal past its expiry no longer describes current, actionable timing. */
export function isSignalExpired(signal: Pick<SignalRecord, "expiresAt">, now: Date = new Date()): boolean {
  if (!signal.expiresAt) return false;
  return new Date(signal.expiresAt).getTime() <= now.getTime();
}

export interface ListSignalsOptions {
  entityType?: string;
  signalType?: string;
  limit?: number;
}

/** Normalized, chronological (oldest → newest) timeline of every signal for an entity. */
export async function listSignalsForEntity(
  db: Db,
  entityId: string,
  opts: ListSignalsOptions = {}
): Promise<SignalRecord[]> {
  const conditions = [eq(signals.entityId, entityId)];
  if (opts.entityType) conditions.push(eq(signals.entityType, opts.entityType));
  if (opts.signalType) conditions.push(eq(signals.signalType, opts.signalType));

  const rows = await db
    .select()
    .from(signals)
    .where(and(...conditions))
    .orderBy(asc(signals.detectedAt))
    .limit(opts.limit ?? 100);

  return rows.map(serialize);
}

/** Lightweight overlay payload for list/TAM/search rows (R11.3). */
export interface OverlaySignal {
  type: string;
  observedAt: string;
  detail?: string;
}

const OVERLAY_PER_ENTITY = 8;

/** Batch-load signal timelines for many entity ids (prospect + company) in one query. */
export async function listSignalsForEntities(db: Db, entityIds: string[]): Promise<Map<string, SignalRecord[]>> {
  const ids = [...new Set(entityIds.filter((id) => id.length > 0))];
  if (ids.length === 0) return new Map();

  const rows = await db
    .select()
    .from(signals)
    .where(inArray(signals.entityId, ids))
    .orderBy(desc(signals.detectedAt));

  const map = new Map<string, SignalRecord[]>();
  for (const row of rows) {
    const list = map.get(row.entityId) ?? [];
    if (list.length >= OVERLAY_PER_ENTITY) continue;
    list.push(serialize(row));
    map.set(row.entityId, list);
  }
  return map;
}

function overlayDetail(value: Record<string, unknown>): string | undefined {
  for (const key of ["reason", "detail", "tool", "technology"]) {
    const v = value[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Merge prospect + company signals, newest first, cap at `max` (default 3). */
export function overlaySignalsForMember(
  byEntity: Map<string, SignalRecord[]>,
  prospectId: string,
  companyId: string,
  max = 3
): OverlaySignal[] {
  const merged = [
    ...(byEntity.get(prospectId) ?? []),
    ...(companyId && companyId !== prospectId ? (byEntity.get(companyId) ?? []) : []),
  ];
  const seen = new Set<string>();
  const unique: SignalRecord[] = [];
  for (const signal of merged) {
    const key = `${signal.signalType}:${signal.detectedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(signal);
  }
  unique.sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime());
  return unique.slice(0, max).map((signal) => {
    const detail = overlayDetail(signal.value);
    return {
      type: signal.signalType,
      observedAt: signal.detectedAt,
      ...(detail ? { detail } : {}),
    };
  });
}

/**
 * Signal types that describe risk/decay rather than buying timing (R18.1/R18.2). These
 * don't corroborate purchase intent, so they're excluded from the stacking score below —
 * stacking them in would reward "this account is going cold" as if it were a hot signal.
 */
const RISK_SIGNAL_TYPES = new Set(["engagement_decay", "negative_sentiment", "budget_freeze"]);

/**
 * Every number the stacking formula depends on — no product/data-science input has
 * calibrated these against real conversion data yet, so they're read from env
 * (SIGNAL_STACK_*, see config/env.ts) rather than baked into the code, and can be
 * retuned with a config change instead of a deploy.
 */
export interface SignalStackWeights {
  /** Confidence to assume for a signal that didn't record one. */
  defaultConfidence: number;
  /** Exponential half-life for signal recency, in days — a signal is worth half as much every N days. */
  recencyHalfLifeDays: number;
  /** A signal past its half-life still counts, but only down to this floor weight. */
  recencyFloor: number;
  /** More distinct signal types corroborating the same timing story score higher than one. */
  multiplierByDistinctTypes: Record<number, number>;
  /** A reachable decision-maker turns a timing signal into an actionable one. */
  decisionMakerMultiplier: number;
  /** Tunes the raw weighted sum into a 0-100 range for a "typical" 1-3 signal stack. */
  scoreScale: number;
}

export const DEFAULT_SIGNAL_STACK_WEIGHTS: SignalStackWeights = {
  defaultConfidence: 0.6,
  recencyHalfLifeDays: 14,
  recencyFloor: 0.05,
  multiplierByDistinctTypes: { 1: 1, 2: 1.3, 3: 1.6 },
  decisionMakerMultiplier: 1.25,
  scoreScale: 35,
};

export function signalStackWeightsFromEnv(config: Env): SignalStackWeights {
  return {
    defaultConfidence: config.SIGNAL_STACK_DEFAULT_CONFIDENCE,
    recencyHalfLifeDays: config.SIGNAL_STACK_RECENCY_HALF_LIFE_DAYS,
    recencyFloor: config.SIGNAL_STACK_RECENCY_FLOOR,
    multiplierByDistinctTypes: {
      1: 1,
      2: config.SIGNAL_STACK_MULTIPLIER_2_TYPES,
      3: config.SIGNAL_STACK_MULTIPLIER_3_TYPES,
    },
    decisionMakerMultiplier: config.SIGNAL_STACK_DECISION_MAKER_MULTIPLIER,
    scoreScale: config.SIGNAL_STACK_SCORE_SCALE,
  };
}

const MAX_STACK_TIER = 3;

export type SignalStackBand = "none" | "cool" | "warm" | "hot";

export interface SignalStackContribution {
  id: string;
  signalType: string;
  confidence: number;
  detectedAt: string;
  weight: number;
}

export interface SignalStackScore {
  score: number;
  band: SignalStackBand;
  distinctSignalTypes: number;
  reachableDecisionMaker: boolean;
  /** Risk-type signals (engagement_decay, ...) are excluded — they don't corroborate timing. */
  contributingSignals: SignalStackContribution[];
}

function recencyWeight(detectedAt: Date, now: Date, weights: SignalStackWeights): number {
  const ageDays = Math.max(0, (now.getTime() - detectedAt.getTime()) / (1000 * 60 * 60 * 24));
  const decayed = 0.5 ** (ageDays / weights.recencyHalfLifeDays);
  return Math.max(weights.recencyFloor, decayed);
}

function bandForScore(score: number): SignalStackBand {
  if (score >= 70) return "hot";
  if (score >= 40) return "warm";
  if (score >= 15) return "cool";
  return "none";
}

/**
 * Explicit, deterministic signal-stacking score (R11.2/D5) — multiple corroborated timing
 * signals plus a reachable decision-maker score measurably higher than one weak trigger.
 * Pure function over already-loaded signals; the caller supplies `reachableDecisionMaker`
 * since that's account/contact data this service doesn't own.
 */
export function computeSignalStackScore(
  signals: SignalRecord[],
  opts: { reachableDecisionMaker?: boolean; now?: Date; weights?: SignalStackWeights } = {}
): SignalStackScore {
  const now = opts.now ?? new Date();
  const reachableDecisionMaker = opts.reachableDecisionMaker ?? false;
  const weights = opts.weights ?? DEFAULT_SIGNAL_STACK_WEIGHTS;

  const eligible = signals.filter((s) => !RISK_SIGNAL_TYPES.has(s.signalType) && !isSignalExpired(s, now));
  if (eligible.length === 0) {
    return { score: 0, band: "none", distinctSignalTypes: 0, reachableDecisionMaker, contributingSignals: [] };
  }

  const weighted = eligible.map((s) => {
    const confidence = s.confidence ?? weights.defaultConfidence;
    // Timing freshness should track when the event actually happened, not when we noticed it.
    const weight = confidence * recencyWeight(new Date(s.observedAt), now, weights);
    return { signal: s, weight };
  });

  const baseScore = weighted.reduce((sum, w) => sum + w.weight, 0);
  const distinctSignalTypes = new Set(eligible.map((s) => s.signalType)).size;
  const stackMultiplier =
    weights.multiplierByDistinctTypes[Math.min(distinctSignalTypes, MAX_STACK_TIER)] ?? 1;
  const dmMultiplier = reachableDecisionMaker ? weights.decisionMakerMultiplier : 1;

  const score = Math.min(100, Math.round(baseScore * stackMultiplier * dmMultiplier * weights.scoreScale));

  return {
    score,
    band: bandForScore(score),
    distinctSignalTypes,
    reachableDecisionMaker,
    contributingSignals: weighted
      .sort((a, b) => b.weight - a.weight)
      .map((w) => ({
        id: w.signal.id,
        signalType: w.signal.signalType,
        confidence: w.signal.confidence ?? weights.defaultConfidence,
        detectedAt: w.signal.detectedAt,
        weight: Math.round(w.weight * 1000) / 1000,
      })),
  };
}

export interface RecordSignalInput {
  entityType?: string;
  entityId: string;
  signalType: string;
  /** Plain-language explanation — required for risk-type signals (R18.1/R18.2 AC2), optional otherwise. */
  reason?: string;
  score?: number;
  confidence?: number;
  /** When the real-world event happened, if known separately from detectedAt. */
  observedAt?: Date;
  detectedAt?: Date;
  source?: string;
  /** Null/undefined = never expires. */
  expiresAt?: Date;
  /** Target actions this signal is permitted to drive; defaults to none (informational only). */
  activationPaths?: TargetAction[];
}

/**
 * Write a signal from apps/api itself (as opposed to the corpus ingestor's `recordSignals` in
 * workers/scrapers/ingestor). Used by workspace-local signal producers — the risk-decay sweep
 * (R18.1), reply-derived risk detection (R18.2) — that don't have a corpus crawl to hang off of.
 */
/** Seniority tiers (SENIORITY_OPTIONS in packages/shared) treated as a reachable decision-maker
 * for the stacking score's decision-maker bonus — excludes "manager"/"individual_contributor". */
const DECISION_MAKER_SENIORITIES = new Set([
  "founder",
  "co_founder",
  "ceo",
  "c_level",
  "vp",
  "director",
  "head",
]);

export interface AccountSignalSummary {
  companyId: string;
  companyName: string | null;
  stackScore: SignalStackScore;
  signals: SignalRecord[];
}

/**
 * 8.5 Ask — "Build a dedicated Signal Center surface listing every live signal per account with
 * strength/expiry/evidence." The single-entity GET /signals lookup can't answer "show me every
 * account with live signals, ranked" — this assembles that view from the workspace's own
 * activated companies, reusing listSignalsForEntities' batch loader and computeSignalStackScore.
 * "Reachable decision-maker" is derived from whether any of the workspace's own activated
 * contacts at that company are in a decision-maker seniority tier — real data, not assumed.
 */
export async function listWorkspaceAccountSignals(
  db: Db,
  config: Env,
  workspaceId: string,
  opts: { limit?: number } = {}
): Promise<AccountSignalSummary[]> {
  const activations = await db
    .select({ companyId: prospectActivations.companyId, snapshot: prospectActivations.snapshot })
    .from(prospectActivations)
    .where(eq(prospectActivations.workspaceId, workspaceId));

  if (activations.length === 0) return [];

  const companyNameById = new Map<string, string>();
  const reachableDecisionMakerByCompany = new Set<string>();
  for (const a of activations) {
    const snapshot = (a.snapshot as Record<string, unknown>) ?? {};
    const companyName = typeof snapshot.companyName === "string" ? snapshot.companyName : undefined;
    if (companyName && !companyNameById.has(a.companyId)) companyNameById.set(a.companyId, companyName);
    const seniority = typeof snapshot.seniority === "string" ? snapshot.seniority.toLowerCase() : "";
    if (DECISION_MAKER_SENIORITIES.has(seniority)) reachableDecisionMakerByCompany.add(a.companyId);
  }

  const companyIds = [...new Set(activations.map((a) => a.companyId))];
  const byEntity = await listSignalsForEntities(db, companyIds);
  const weights = signalStackWeightsFromEnv(config);

  const summaries: AccountSignalSummary[] = companyIds
    .map((companyId) => {
      const companySignals = byEntity.get(companyId) ?? [];
      return {
        companyId,
        companyName: companyNameById.get(companyId) ?? null,
        stackScore: computeSignalStackScore(companySignals, {
          weights,
          reachableDecisionMaker: reachableDecisionMakerByCompany.has(companyId),
        }),
        signals: companySignals,
      };
    })
    .filter((s) => s.signals.length > 0)
    .sort((a, b) => b.stackScore.score - a.stackScore.score);

  return opts.limit ? summaries.slice(0, opts.limit) : summaries;
}

export async function recordSignal(db: Db, input: RecordSignalInput): Promise<SignalRecord> {
  const [row] = await db
    .insert(signals)
    .values({
      entityType: input.entityType ?? "prospect",
      entityId: input.entityId,
      signalType: input.signalType,
      value: {
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.score !== undefined ? { score: input.score } : {}),
      },
      confidence: input.confidence ?? null,
      observedAt: input.observedAt ?? null,
      detectedAt: input.detectedAt ?? new Date(),
      source: input.source ?? null,
      expiresAt: input.expiresAt ?? null,
      activationPaths: input.activationPaths ?? [],
    })
    .returning();
  return serialize(row!);
}
