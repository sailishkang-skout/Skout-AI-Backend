import type { Db } from "@skout/db";
import { assertEvidenced } from "@skout/shared";
import { recordEvidence } from "./evidence.service.js";
import { buildModelVersionsService } from "./model-versions.service.js";
import { incrJourneyMetric } from "./journey-metrics.js";

const DEFAULT_AI_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

export interface PinAiClaimInput {
  workspaceId: string;
  entityType: string;
  entityId: string;
  attribute: string;
  value: unknown;
  source: string;
  method: string;
  /** Logical model/prompt catalog name, e.g. "generate-email", "suggest-reply", "chat". */
  versionName?: string;
  confidence?: number;
  freshnessMs?: number;
}

/**
 * §6.1 / §5.1 — record an AI claim into evidence_ledger (with ModelVersion pin when
 * available) and fail-closed via assertEvidenced. Returns evidenceId + version ids
 * for the API response envelope.
 */
export async function pinAiClaim(
  db: Db,
  input: PinAiClaimInput
): Promise<{ evidenceId: string; modelVersionId: string | null; promptVersionId: string | null }> {
  const versions = buildModelVersionsService(db);
  let modelVersionId: string | null = null;
  let promptVersionId: string | null = null;
  if (versions && input.versionName) {
    const [activeModel, activePrompt] = await Promise.all([
      versions.getActiveModelVersion(input.versionName),
      versions.getActivePromptVersion(input.versionName),
    ]);
    modelVersionId = activeModel?.id ?? null;
    promptVersionId = activePrompt?.id ?? null;
  }

  const freshnessMs = input.freshnessMs ?? DEFAULT_AI_FRESHNESS_MS;
  const row = await recordEvidence(db, {
    workspaceId: input.workspaceId,
    entityType: input.entityType,
    entityId: input.entityId,
    attribute: input.attribute,
    value: input.value,
    source: input.source,
    observedAt: new Date(),
    confidence: input.confidence ?? 0.7,
    method: input.method,
    resolutionRuleOrModelVersion: modelVersionId ?? promptVersionId ?? undefined,
    freshnessExpiresAt: new Date(Date.now() + freshnessMs),
  });

  const evidenceId = row?.id;
  try {
    assertEvidenced({ value: input.value, evidenceId }, input.attribute);
    if (!evidenceId) {
      throw new Error(`evidence write returned no id for ${input.attribute}`);
    }
    incrJourneyMetric("aiPinSuccess");
    incrJourneyMetric("evidenceWrite");
    return { evidenceId, modelVersionId, promptVersionId };
  } catch (err) {
    incrJourneyMetric("aiPinFail");
    throw err;
  }
}
