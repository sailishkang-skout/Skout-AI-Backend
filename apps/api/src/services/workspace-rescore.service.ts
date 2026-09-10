import { eq } from "drizzle-orm";
import { createLogger } from "@skout/observability";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { isRedisAvailable } from "../lib/redis.js";
import { buildEnrichmentService } from "./enrichment/index.js";
import { enqueueWorkspaceRescoreJob } from "../workers/workspace-rescore.queue.js";
import { getAsyncJob } from "./async-job.service.js";
import type { IcpConfig } from "./enrichment/ai-client.js";
import { isIcpConfigured } from "./icp.service.js";

const { asyncJobs } = schema;
const log = createLogger("workspace-rescore.service");

export function isAutoRescoreEnabled(config: IcpConfig): boolean {
  return config.autoRescoreOnChange !== false;
}

/** Enqueue (or run sync) a workspace-wide re-score after ICP version bump. */
export async function startWorkspaceRescoreIfEnabled(
  db: Db | null,
  config: Env,
  workspaceId: string,
  icpConfig: IcpConfig,
  icpVersion: number,
  previousVersion: number
) {
  if (!db) return null;
  if (icpVersion <= 1 || previousVersion >= icpVersion) return null;
  if (!isIcpConfigured(icpConfig)) return null;
  if (!isAutoRescoreEnabled(icpConfig)) return null;

  const svc = buildEnrichmentService(db, config);
  const prepared = await svc.prepareWorkspaceRescore(workspaceId);
  if (prepared.snapshots.length === 0) return null;

  if (await isRedisAvailable(config)) {
    const [job] = await db
      .insert(asyncJobs)
      .values({
        workspaceId,
        jobType: "icp_rescore",
        status: "pending",
        entityType: "workspace",
        entityId: workspaceId,
        payload: {
          icpVersion,
          prospectCount: prepared.snapshots.length,
          estimatedCredits: prepared.totalCost,
        },
      })
      .returning();

    try {
      await enqueueWorkspaceRescoreJob(config, {
        jobId: job.id,
        workspaceId,
        icpVersion,
      });
    } catch (err) {
      log.error("Failed to enqueue workspace rescore job", err, { jobId: job.id });
      await db
        .update(asyncJobs)
        .set({
          status: "failed",
          errorMessage: "queue_unavailable",
          completedAt: new Date(),
        })
        .where(eq(asyncJobs.id, job.id));
      return null;
    }

    return { jobId: job.id, status: "pending" as const };
  }

  const result = await svc.runWorkspaceRescore(workspaceId, icpVersion);
  return { status: "completed" as const, ...result };
}

export class WorkspaceRescoreService {
  constructor(
    private readonly db: Db,
    private readonly config: Env
  ) {}

  async getJob(workspaceId: string, jobId: string) {
    return getAsyncJob(this.db, workspaceId, jobId);
  }
}
