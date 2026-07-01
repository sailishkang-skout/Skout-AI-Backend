import { eq } from "drizzle-orm";
import { createLogger } from "@skout/observability";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { buildEnrichmentService } from "./enrichment/index.js";
import { createSearchCacheService } from "./search-cache.service.js";

const { asyncJobs } = schema;
const log = createLogger("workspace-rescore.runner");

export interface WorkspaceRescoreJobResult {
  workspaceId: string;
  icpVersion: number;
  scored: number;
  skipped: number;
  creditsUsed: number;
  results: Array<{ prospectId: string; icpScore: number; icpBand: string }>;
}

export async function runWorkspaceRescoreJob(
  db: Db,
  config: Env,
  jobId: string,
  workspaceId: string,
  icpVersion: number
): Promise<WorkspaceRescoreJobResult> {
  await db
    .update(asyncJobs)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(asyncJobs.id, jobId));

  const svc = buildEnrichmentService(db, config);

  try {
    const result = await svc.runWorkspaceRescore(workspaceId, icpVersion, {
      onProgress: async (progress) => {
        await db
          .update(asyncJobs)
          .set({
            result: {
              workspaceId,
              icpVersion,
              scored: progress.scored,
              total: progress.total,
              creditsUsed: progress.creditsUsed,
              results: progress.results,
            },
          })
          .where(eq(asyncJobs.id, jobId));
      },
    });

    const final: WorkspaceRescoreJobResult = { workspaceId, icpVersion, ...result };
    await db
      .update(asyncJobs)
      .set({
        status: "completed",
        result: final,
        completedAt: new Date(),
      })
      .where(eq(asyncJobs.id, jobId));

    const cache = createSearchCacheService(config);
    await Promise.all(result.results.map((r) => cache.invalidateById(workspaceId, r.prospectId)));

    return final;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Workspace rescore job failed", err, { jobId, workspaceId, icpVersion });
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
