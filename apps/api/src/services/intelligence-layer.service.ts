import type { ActivationRuleDto } from "./activation-rules.service.js";

/**
 * §6.0 — The Skout Intelligence Layer: a shared platform capability the doc's 8-step pipeline
 * (ingest / normalize identity / resolve fields / derive signals / score / generate / apply
 * policy / capture feedback) is meant to live behind, instead of each domain reimplementing its
 * own slice. This module starts with step 7 only — the other steps land as real fragments
 * migrate, not as speculative stubs.
 *
 * First adopter: activation-rules.service.ts's matchActivationRules is now a thin DB-fetching
 * wrapper around this pure function.
 */

/**
 * Step 7 — apply policy: decide which enabled rules match a prospect's score/signals, without
 * executing anything. Deliberately dependency-free (no DB access) so any domain can call in
 * without adopting this one's persistence pattern.
 */
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

export interface GeneratedSuggestion {
  actionType: string;
  headline: string;
  rationale: string;
  draftMessage?: string;
}

/**
 * Step 6 — generate explanations/recommendations: turn a raw LLM JSON response into a validated
 * suggestion, with a safe fallback when the model returns malformed JSON or an out-of-set
 * actionType. Kept scoped to next-best-action's exact response shape for now rather than
 * generalized further — a second consumer of step 6 is what should drive what actually
 * generalizes, not a guess made before one exists.
 */
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
