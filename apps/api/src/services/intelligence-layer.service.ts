import type { ActivationRuleDto } from "./activation-rules.service.js";
import type { IcpConfig, ScoreInput, ScoreResult } from "./enrichment/ai-client.js";
import { scoreLocally, scoreProspect } from "./enrichment/ai-client.js";

export type { IcpConfig, ScoreInput, ScoreResult };

/**
 * §6.0 — The Skout Intelligence Layer: shared 8-step pipeline behind domain fragments.
 * Steps 1–5 are pure/normalizing; step 6–7 are pure policy/generation; step 8 records feedback.
 *
 * Adopters (thin callers):
 *  - activation-rules.service.ts → applyPolicy (step 7)
 *  - next-best-action.service.ts → parseNextBestActionResponse (step 6)
 *  - enrichment/service.ts → scoreProspectIcp (step 5)
 *  - ai-workspace-tools.service.ts → buildToolActionPreview + applyPolicy (steps 7 + preview)
 */

// ── Step 1: ingest ───────────────────────────────────────────────────────────

export interface RawObservation {
  entityType: string;
  entityId: string;
  attribute: string;
  value: unknown;
  source?: string;
  observedAt?: string;
}

export interface NormalizedObservation {
  entityType: string;
  entityId: string;
  attribute: string;
  value: unknown;
  source: string;
  observedAt: string;
}

export function ingestObservation(raw: RawObservation): NormalizedObservation {
  return {
    entityType: raw.entityType.trim() || "unknown",
    entityId: raw.entityId.trim(),
    attribute: raw.attribute.trim(),
    value: raw.value,
    source: raw.source?.trim() || "unknown",
    observedAt: raw.observedAt ?? new Date().toISOString(),
  };
}

// ── Step 2: normalize identity ───────────────────────────────────────────────

export function normalizeEntityKey(entityType: string, entityId: string): string {
  return `${entityType.trim().toLowerCase()}:${entityId.trim().toLowerCase()}`;
}

// ── Step 3: resolve fields ───────────────────────────────────────────────────

export interface FieldCandidate {
  value: unknown;
  confidence: number;
  source: string;
  observedAt?: string;
}

export function resolveCanonicalField(candidates: FieldCandidate[]): FieldCandidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const aTime = a.observedAt ? Date.parse(a.observedAt) : 0;
    const bTime = b.observedAt ? Date.parse(b.observedAt) : 0;
    return bTime - aTime;
  })[0]!;
}

// ── Step 4: derive signals ───────────────────────────────────────────────────

export function deriveActiveSignalTypes(
  signals: Array<{ signalType: string; expiresAt?: string | Date | null }>,
  now: Date = new Date()
): string[] {
  const active = signals.filter((s) => {
    if (!s.expiresAt) return true;
    const exp = s.expiresAt instanceof Date ? s.expiresAt : new Date(s.expiresAt);
    return exp.getTime() > now.getTime();
  });
  return [...new Set(active.map((s) => s.signalType))];
}

// ── Step 5: score ────────────────────────────────────────────────────────────

/** Thin wrapper — enrichment.service calls this instead of ai-client directly. */
export function scoreIcpFitLocally(input: ScoreInput, icp: IcpConfig = {}): ScoreResult {
  return scoreLocally(input, icp);
}

export async function scoreProspectIcp(
  aiServiceUrl: string | undefined,
  input: ScoreInput,
  icp: IcpConfig,
  timeoutMs: number,
  openrouterApiKey?: string
): Promise<ScoreResult> {
  return scoreProspect(aiServiceUrl, input, icp, timeoutMs, openrouterApiKey);
}

// ── Step 6: generate ─────────────────────────────────────────────────────────

export interface GeneratedSuggestion {
  actionType: string;
  headline: string;
  rationale: string;
  draftMessage?: string;
}

export function parseNextBestActionResponse(raw: string, validActionTypes: readonly string[]): GeneratedSuggestion {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { actionType: "wait", headline: "Could not parse a suggestion", rationale: raw.slice(0, 300) };
  }

  const actionType = validActionTypes.includes(parsed.actionType as string) ? (parsed.actionType as string) : "wait";

  return {
    actionType,
    headline: typeof parsed.headline === "string" ? parsed.headline : "Review this record",
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    draftMessage: typeof parsed.draftMessage === "string" ? parsed.draftMessage : undefined,
  };
}

// ── Step 7: apply policy ─────────────────────────────────────────────────────

export function applyPolicy(
  rules: ActivationRuleDto[],
  prospectScore: number,
  activeSignalTypes: string[]
): ActivationRuleDto[] {
  return rules.filter((rule) => {
    if (!rule.enabled) return false;
    if (prospectScore < rule.scoreThreshold) return false;
    if (rule.signalType && !activeSignalTypes.includes(rule.signalType)) return false;
    return true;
  });
}

// ── Step 8: capture feedback ─────────────────────────────────────────────────

export interface IntelligenceFeedback {
  recommendationId: string;
  outcome: "accepted" | "rejected" | "ignored";
  attribution?: string;
  thresholdDelta?: number;
}

export function captureFeedback(feedback: IntelligenceFeedback): IntelligenceFeedback {
  return {
    ...feedback,
    attribution: feedback.attribution ?? "user_action",
    thresholdDelta: feedback.thresholdDelta ?? 0,
  };
}

// ── §8.13 tool preview (uses policy metadata) ──────────────────────────────

export interface ToolActionPreview {
  toolName: string;
  scope: string;
  assumptions: string[];
  affectedRecordCount: number;
  creditCost: number;
  externalSideEffects: string[];
  args: Record<string, unknown>;
}

export const MUTATING_TOOL_NAMES = new Set(["create_outbound_sequence"]);

export function buildToolActionPreview(
  toolName: string,
  args: Record<string, unknown>,
  opts: { policyMode?: string } = {}
): ToolActionPreview {
  const steps = Array.isArray(args.steps) ? args.steps : [];
  const stepCount = steps.length;
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "Outbound Cadence";

  return {
    toolName,
    scope: `Create sequence "${name}" with ${stepCount || "N"} step(s) in this workspace`,
    assumptions: [
      "Merge tokens will be resolved at send time",
      opts.policyMode ? `Policy mode: ${opts.policyMode}` : "Policy Gateway will classify before execute",
    ],
    affectedRecordCount: stepCount,
    creditCost: 0,
    externalSideEffects: [
      "Creates a new sequence definition (no enrollments until you enroll contacts)",
      "Sequence steps may send email or LinkedIn touches when enrollments run",
    ],
    args,
  };
}
