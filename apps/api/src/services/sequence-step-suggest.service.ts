import type { Db } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { aiService } from "./ai.service.js";
import { pinAiClaim } from "./ai-evidence.service.js";
import { computeOutcomeInsights, insightsToPrompt } from "./outcome-insights.service.js";
import { buildAudienceSummary } from "./sequence-generate.service.js";
import { SequenceService } from "./sequence.service.js";
import {
  summarizeSiblingStep,
  type StepSuggestion,
  type StepSuggestionTarget,
} from "./sequence-step-suggestions.js";

/** How many neighbouring steps to show the model — enough for continuity, small enough to stay cheap. */
const BEFORE_LIMIT = 4;
const AFTER_LIMIT = 2;

export interface SuggestStepInput {
  target: StepSuggestionTarget;
  /** The step being edited. Omit for a step that is about to be appended. */
  stepId?: string;
  excludeAngles?: string[];
}

export interface SuggestStepResult {
  suggestions: StepSuggestion[];
  evidenceId: string;
  modelVersionId: string | null;
  promptVersionId: string | null;
}

/**
 * Suggests Email / LinkedIn copy for one step of an existing sequence. Context comes from the
 * sequence itself (name + neighbouring steps) plus the enrolled list's audience and the
 * workspace's outcome insights when those exist — the latter two are best-effort.
 */
export async function suggestStepForSequence(
  db: Db,
  config: Env,
  workspaceId: string,
  sequenceId: string,
  input: SuggestStepInput
): Promise<SuggestStepResult> {
  const seqSvc = new SequenceService(db);
  const sequence = await seqSvc.getSequenceById(workspaceId, sequenceId);
  if (!sequence) throw new HttpError("sequence_not_found", 404);

  const ordered = [...sequence.steps].sort((a, b) => a.stepOrder - b.stepOrder);
  const currentIdx = input.stepId ? ordered.findIndex((s) => s.id === input.stepId) : -1;
  if (input.stepId && currentIdx === -1) throw new HttpError("step_not_found", 404);

  const isNewStep = currentIdx === -1;
  const others = ordered.filter((_, i) => i !== currentIdx);
  const splitAt = isNewStep ? others.length : currentIdx;
  const before = others.slice(0, splitAt).slice(-BEFORE_LIMIT).map(summarizeSiblingStep);
  const after = others.slice(splitAt, splitAt + AFTER_LIMIT).map(summarizeSiblingStep);

  const [audience, insights] = await Promise.all([
    seqSvc
      .listEnrolledLists(workspaceId, sequenceId)
      .then((lists) => (lists?.[0] ? buildAudienceSummary(db, workspaceId, lists[0].listId) : null))
      .catch(() => null),
    computeOutcomeInsights(db, workspaceId)
      .then(insightsToPrompt)
      .catch(() => null),
  ]);

  const suggestions = await aiService.suggestStepContent(
    {
      sequenceName: sequence.name,
      target: input.target,
      position: isNewStep ? ordered.length + 1 : currentIdx + 1,
      total: isNewStep ? ordered.length + 1 : ordered.length,
      before,
      after,
      audience,
      insights,
      excludeAngles: input.excludeAngles,
    },
    config.OPENROUTER_API_KEY
  );

  const pinned = await pinAiClaim(db, {
    workspaceId,
    entityType: "sequence",
    entityId: sequenceId,
    attribute: "ai_step_suggestions",
    value: {
      stepId: input.stepId ?? null,
      stepType: input.target.stepType,
      linkedinAction: input.target.linkedinAction ?? null,
      angles: suggestions.map((s) => s.angle),
    },
    source: "sequence_step_suggest",
    method: "sequence_step_suggest",
    versionName: "sequence-step-suggest",
    confidence: 0.7,
  });

  return {
    suggestions,
    evidenceId: pinned.evidenceId,
    modelVersionId: pinned.modelVersionId,
    promptVersionId: pinned.promptVersionId,
  };
}
