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
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
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
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}
