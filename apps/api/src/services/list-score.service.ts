import { and, eq } from "drizzle-orm";
import { createLogger } from "@skout/observability";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { isRedisAvailable } from "../lib/redis.js";
import { buildEnrichmentService } from "./enrichment/index.js";
import { enqueueListScoreJob } from "../workers/list-score.queue.js";
import type { ListScoreJobResult } from "./list-score.runner.js";

const { asyncJobs } = schema;
const log = createLogger("list-score.service");

export class ListScoreService {
  constructor(
    private readonly db: Db,
    private readonly config: Env
  ) {}

  async start(workspaceId: string, listId: string) {
    const svc = buildEnrichmentService(this.db, this.config);
    const prepared = await svc.prepareListScore(workspaceId, listId);

    if (await isRedisAvailable(this.config)) {
      const [job] = await this.db
        .insert(asyncJobs)
        .values({
          workspaceId,
          jobType: "ai_inference",
          status: "pending",
          entityType: "list",
          entityId: listId,
          payload: {
            listId,
            prospectCount: prepared.snapshots.length,
            estimatedCredits: prepared.totalCost,
          },
        })
        .returning();

      try {
        await enqueueListScoreJob(this.config, {
          jobId: job.id,
          workspaceId,
          listId,
        });
      } catch (err) {
        log.error("Failed to enqueue list score job", err, { jobId: job.id });
        await this.db
          .update(asyncJobs)
          .set({
            status: "failed",
            errorMessage: "queue_unavailable",
            completedAt: new Date(),
          })
          .where(eq(asyncJobs.id, job.id));
        throw new HttpError("score_queue_unavailable", 503);
      }

      return { jobId: job.id, status: "pending" as const };
    }

    const result = await svc.runListScore(workspaceId, listId);
    return { status: "completed" as const, ...result };
  }

  async getJob(workspaceId: string, jobId: string) {
    const [job] = await this.db
      .select()
      .from(asyncJobs)
      .where(and(eq(asyncJobs.id, jobId), eq(asyncJobs.workspaceId, workspaceId)));
    if (!job) throw new HttpError("job_not_found", 404);
    return {
      id: job.id,
      jobType: job.jobType,
      status: job.status,
      entityType: job.entityType,
      entityId: job.entityId,
      result: job.result as ListScoreJobResult | null,
      errorMessage: job.errorMessage,
      queuedAt: job.queuedAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  }
}

export { InsufficientCreditsError } from "./enrichment/index.js";
