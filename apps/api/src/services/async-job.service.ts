import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "../utils/http.js";

const { asyncJobs } = schema;

export interface AsyncJobView {
  id: string;
  jobType: string;
  status: string;
  entityType: string | null;
  entityId: string | null;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  progress: number | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

const CANCELLABLE_STATUSES = new Set(["pending", "running"]);

/**
 * Cooperative cancel: flips status to "cancelled" so a running job's next progress tick
 * can notice and stop itself. Does not forcibly kill in-flight work.
 */
export async function cancelAsyncJob(db: Db, workspaceId: string, jobId: string): Promise<AsyncJobView> {
  const [job] = await db
    .select()
    .from(asyncJobs)
    .where(and(eq(asyncJobs.id, jobId), eq(asyncJobs.workspaceId, workspaceId)));
  if (!job) throw new HttpError("job_not_found", 404);
  if (!CANCELLABLE_STATUSES.has(job.status)) {
    throw new HttpError("job_not_cancellable", 409);
  }

  await db
    .update(asyncJobs)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(asyncJobs.id, jobId));

  return getAsyncJob(db, workspaceId, jobId);
}

export async function getAsyncJob(db: Db, workspaceId: string, jobId: string): Promise<AsyncJobView> {
  const [job] = await db
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
    result: (job.result as Record<string, unknown> | null) ?? null,
    errorMessage: job.errorMessage,
    progress: job.progress ?? null,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}
