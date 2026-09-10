import { eq } from "drizzle-orm";
import { createLogger } from "@skout/observability";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { buildEnrichmentService } from "./enrichment/index.js";
import { createSearchCacheService } from "./search-cache.service.js";

const { asyncJobs } = schema;
const log = createLogger("workspace-rescore.runner");

export class JobCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "JobCancelledError";
  }
}

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
  const [existing] = await db
    .select({ status: asyncJobs.status })
    .from(asyncJobs)
    .where(eq(asyncJobs.id, jobId));
  if (existing?.status === "cancelled") {
    // Cancelled while still queued — never picked up, nothing to run.
    throw new JobCancelledError();
  }

  await db
    .update(asyncJobs)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(asyncJobs.id, jobId));

  const svc = buildEnrichmentService(db, config);

  try {
    const result = await svc.runWorkspaceRescore(workspaceId, icpVersion, {
      onProgress: async (progress) => {
        const percent =
          progress.total > 0 ? Math.round((progress.scored / progress.total) * 100) : 100;
        await db
          .update(asyncJobs)
          .set({
            progress: percent,
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

        const [current] = await db
          .select({ status: asyncJobs.status })
          .from(asyncJobs)
          .where(eq(asyncJobs.id, jobId));
        if (current?.status === "cancelled") {
          throw new JobCancelledError();
        }
      },
    });

    const final: WorkspaceRescoreJobResult = { workspaceId, ...result };
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
    if (err instanceof JobCancelledError) {
      log.info("Workspace rescore job cancelled", { jobId, workspaceId, icpVersion });
      await db
        .update(asyncJobs)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(eq(asyncJobs.id, jobId));
      throw err;
    }

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
