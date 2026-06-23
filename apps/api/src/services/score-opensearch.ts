import { bulkPatchProspectScores } from "@skout/opensearch";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import type { ScoreResult } from "../services/enrichment/ai-client.js";
import { openSearchConfigFromEnv } from "../lib/opensearch-config.js";

const log = createLogger("score-opensearch");

/** Mirror workspace scores into the global OpenSearch corpus when configured. */
export async function writeScoreToOpenSearch(env: Env, result: ScoreResult): Promise<void> {
  const cfg = openSearchConfigFromEnv(env);
  if (!cfg) return;

  try {
    const { updated, failed } = await bulkPatchProspectScores(cfg, [
      {
        prospectId: result.prospectId,
        icpScore: result.icpScore,
        intentScore: result.intentScore,
        painPoints: result.painPoints,
        outreachReadiness: result.outreachReadiness,
      },
    ]);
    if (failed > 0) {
      log.debug("OpenSearch score patch missed document", { prospectId: result.prospectId, updated, failed });
    }
  } catch (err) {
    log.warn("OpenSearch score writeback failed", { prospectId: result.prospectId, err });
  }
}
