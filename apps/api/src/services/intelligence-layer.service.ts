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
