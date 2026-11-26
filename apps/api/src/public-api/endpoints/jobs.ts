import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import type { Env } from "../../config/env.js";
import { PublicApiError } from "../errors.js";
import type { ApiJobStatus } from "../jobs.js";
import type { PublicEndpoint } from "../pipeline.js";

/**
 * GET /jobs/{id} (PAPI-060, public API PRD §7.3, §7.7 JOB-2).
 *
 * A batch job's status, progress and, once it has finished, its per-item results, for 7 days after it
 * finished. Free, any scope. A job of another workspace, an unknown id and an expired job are all
 * simply not found.
 */
export interface PublicJob {
  id: string;
  /** The operation the job runs, e.g. emails.verify. */
  type: string;
  status: ApiJobStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** When the results are deleted (7 days after the job finished). */
  results_expire_at: string | null;
  /** Per-item results in the order sent; null until the job has finished. */
  results: unknown[] | null;
}

const input = z.object({ id: z.string().min(1).max(600) }).strict();
const FINISHED = new Set<string>(["completed", "failed", "partially_completed"]);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function createGetJobEndpoint(deps: { env: Env; db: Db }): PublicEndpoint<typeof input, PublicJob> {
  return {
    method: "GET",
    path: "/jobs/:id",
    scope: "any",
    operation: null,
    input,
    maxCost: () => 0,

    async handle({ input, workspaceId, ids }) {
      const jobId = ids.decode("job", input.id);
      const { apiJobs } = schema;
      const [job] = jobId
        ? await deps.db
            .select()
            .from(apiJobs)
            .where(and(eq(apiJobs.id, jobId), eq(apiJobs.workspaceId, workspaceId)))
            .limit(1)
        : [];
      // Expired results are deleted by maintenance; one past its window but not yet purged is gone too.
      if (!job || (job.resultsExpireAt && job.resultsExpireAt.getTime() <= Date.now())) {
        throw new PublicApiError("not_found", "No job matches. Job results are kept for 7 days after the job finishes.");
      }
      const finished = FINISHED.has(job.status);
      return {
        data: {
          id: input.id,
          type: job.operation,
          status: job.status as ApiJobStatus,
          total: job.totalItems,
          processed: job.processedItems,
          succeeded: job.succeededItems,
          failed: job.failedItems,
          error_code: job.errorCode,
          created_at: job.createdAt.toISOString(),
          started_at: iso(job.startedAt),
          finished_at: iso(job.finishedAt),
          results_expire_at: iso(job.resultsExpireAt),
          results: finished ? ((job.results as unknown[] | null) ?? []) : null,
        },
        charge: 0,
      };
    },

    fixture: (i) => ({
      id: i.id,
      type: "emails.verify",
      status: "completed",
      total: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      error_code: null,
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-01T00:00:01.000Z",
      finished_at: "2026-01-01T00:00:02.000Z",
      results_expire_at: "2026-01-08T00:00:02.000Z",
      results: [{ email: "ada@example.com", status: "valid", disposable: false, catch_all: false, suggested_domain: null, checked_at: "2026-01-01T00:00:02.000Z" }],
    }),
  };
}
