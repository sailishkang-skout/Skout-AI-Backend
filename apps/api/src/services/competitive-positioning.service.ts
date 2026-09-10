import type { RegionalTamGate } from "./regional-tam-gate.service.js";
import { REGIONAL_TAM_MIN_DEALS } from "./regional-tam-gate.service.js";

/** §2 — leadership-approved differentiators pending buyer validation. */
export const PROPOSED_DIFFERENTIATORS = [
  "regional_intelligence",
  "evidence_backed_recommendations",
  "operator_control",
] as const;

export type ProposedDifferentiator = (typeof PROPOSED_DIFFERENTIATORS)[number];

export type CompetitivePositioningStatus =
  | "proposed_not_proven"
  | "validated";

export interface CompetitivePositioningPolicy {
  status: CompetitivePositioningStatus;
  differentiators: ProposedDifferentiator[];
  /** Human-readable policy for GTM / marketing. */
  marketingPolicy: string;
  regionalTamLearning: "no_go" | "go";
  pilotFeedbackTrack: string;
  validatedWhen: string;
  leadershipDecisionDate: string;
  policyDoc: string;
}

const LEADERSHIP_DECISION_DATE = "2026-08-29";
const POLICY_DOC = "docs/ops/competitive-win-loss-process.md";

export function buildCompetitivePositioningPolicy(
  gate: RegionalTamGate,
  dealsReviewed: number
): CompetitivePositioningPolicy {
  const validated = gate === "validated";
  return {
    status: validated ? "validated" : "proposed_not_proven",
    differentiators: [...PROPOSED_DIFFERENTIATORS],
    marketingPolicy: validated
      ? "Marketing may cite differentiators only when supported by recorded win/loss evidence."
      : "Treat regional intelligence, evidence-backed recommendations, and operator control as proposed hypotheses — not proven competitive advantages. Limit public claims to substantiated product facts.",
    regionalTamLearning: validated ? "go" : "no_go",
    pilotFeedbackTrack:
      "When <4 closed deals exist, collect structured prospect/pilot feedback separately (see competitive-win-loss-process.md § Pilot feedback).",
    validatedWhen: `≥${REGIONAL_TAM_MIN_DEALS} real won/lost deals in competitive_win_loss_deals (have ${dealsReviewed})`,
    leadershipDecisionDate: LEADERSHIP_DECISION_DATE,
    policyDoc: POLICY_DOC,
  };
}
