import { eq } from "drizzle-orm";
import { createLogger } from "@skout/observability";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { buildEnrichmentService } from "../services/enrichment/index.js";
import { createSearchCacheService } from "./search-cache.service.js";
import { executeActivationRules } from "./activation-rules.service.js";

const { asyncJobs } = schema;
const log = createLogger("list-score.runner");

export interface ListScoreJobResult {
  listId: string;
  scored: number;
  skipped: number;
  creditsUsed: number;
  results: Array<{ prospectId: string; icpScore: number; icpBand: string }>;
}

export async function runListScoreJob(
  db: Db,
  config: Env,
  jobId: string,
  workspaceId: string,
  listId: string
): Promise<ListScoreJobResult> {
  await db
    .update(asyncJobs)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(asyncJobs.id, jobId));

  const svc = buildEnrichmentService(db, config);

  try {
    const result = await svc.runListScore(workspaceId, listId, {
      onProgress: async (progress) => {
        await db
          .update(asyncJobs)
          .set({
            result: {
              listId,
              scored: progress.scored,
              total: progress.total,
              creditsUsed: progress.creditsUsed,
              results: progress.results,
            },
          })
          .where(eq(asyncJobs.id, jobId));
      },
    });

    await db
      .update(asyncJobs)
      .set({
        status: "completed",
        result: result,
        completedAt: new Date(),
      })
      .where(eq(asyncJobs.id, jobId));

    const cache = createSearchCacheService(config);
    await Promise.all(result.results.map((r) => cache.invalidateById(workspaceId, r.prospectId)));

    // R13.4 — fire auto-activation rules now that fresh scores exist. Best-effort: a rule
    // failure (e.g. a deleted target list) must never fail the scoring job itself.
    for (const r of result.results) {
      try {
        const outcome = await executeActivationRules(db, config, workspaceId, r.prospectId, r.icpScore);
        if (outcome.executed > 0 || outcome.failed > 0) {
          log.info("activation rules fired for scored prospect", {
            workspaceId,
            prospectId: r.prospectId,
            ...outcome,
          });
        }
      } catch (err) {
        log.error("activation rule pass failed for prospect", err, { workspaceId, prospectId: r.prospectId });
      }
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("List score job failed", err, { jobId, workspaceId, listId });
    await db
      .update(asyncJobs)
      .set({
        status: "failed",
        errorMessage: message,
        completedAt: new Date(),
      })
      .where(eq(asyncJobs.id, jobId));
    throw err;
  }
}
