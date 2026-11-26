import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { createLogger } from "@skout/observability";
import { commit, release } from "../services/api-credits.service.js";

/**
 * Public API batch jobs (PAPI-058, PRD §7.7 JOB-1, JOB-2).
 *
 * A batch endpoint reserves credits for the whole batch at the current price, creates an api_jobs
 * row holding the items and that price, hands the hold to the job and answers 202. The job runs the
 * items (a few at a time), records each item's result, then charges the successful items at the
 * reserved price and releases the rest of the hold. Results stay available for 7 days.
 *
 * The charge is posted once when the job finishes (successful items × the reserved price), not one
 * ledger row per item; a job whose worker dies charges nothing and its hold expires on its own.
 */
const log = createLogger("public-api.jobs");
const { apiJobs } = schema;

export const API_JOB_RESULTS_MS = 7 * 86_400_000;
/** How long a batch's credit hold lasts: past the point the maintenance job gives a stuck job up. */
export const API_JOB_HOLD_TTL_MS = 7 * 60 * 60_000;

export type ApiJobStatus = "queued" | "running" | "completed" | "failed" | "partially_completed";

export interface BatchJobInput<I> {
  items: I[];
  /** Credits per successful item, fixed when the batch was reserved (JOB-1). */
  pricePerItem: number;
}

/** One item's outcome: `ok` items are charged; failed ones are not. */
export type ItemOutcome<R> = { ok: true; result: R } | { ok: false; result: R };

export interface BatchRunner<I, R> {
  /** Runs one item; throwing counts the item as failed with `failed(item)` as its result. */
  run: (item: I, ctx: { workspaceId: string; apiKeyId: string | null; requestId: string }) => Promise<R>;
  failed: (item: I) => R;
  /** Items run at the same time. */
  concurrency?: number;
}

export async function createBatchJob<I>(
  db: Db,
  input: {
    workspaceId: string;
    apiKeyId: string;
    requestId: string;
    operation: string;
    holdId: string | null;
    items: I[];
    pricePerItem: number;
  }
): Promise<string> {
  const [row] = await db
    .insert(apiJobs)
    .values({
      workspaceId: input.workspaceId,
      apiKeyId: input.apiKeyId,
      requestId: input.requestId,
      operation: input.operation,
      status: "queued",
      totalItems: input.items.length,
      holdId: input.holdId,
      input: { items: input.items, pricePerItem: input.pricePerItem } satisfies BatchJobInput<I>,
    })
    .returning({ id: apiJobs.id });
  return row!.id;
}

/**
 * Runs a queued job to the end. Safe to call twice: a job another run already started or finished is
 * left alone. Never throws for an item failure; a crash marks the job failed and releases the hold.
 */
export async function runBatchJob<I, R>(db: Db, jobId: string, runner: BatchRunner<I, R>, now: () => Date = () => new Date()): Promise<ApiJobStatus | null> {
  const [claimed] = await db
    .update(apiJobs)
    .set({ status: "running", startedAt: now() })
    .where(and(eq(apiJobs.id, jobId), eq(apiJobs.status, "queued")))
    .returning();
  if (!claimed) return null;

  const { items, pricePerItem } = (claimed.input ?? { items: [], pricePerItem: 0 }) as BatchJobInput<I>;
  const ctx = { workspaceId: claimed.workspaceId, apiKeyId: claimed.apiKeyId, requestId: claimed.requestId };
  const results: R[] = new Array(items.length);
  let succeeded = 0;
  let failed = 0;
  try {
    const size = Math.max(1, runner.concurrency ?? 5);
    for (let start = 0; start < items.length; start += size) {
      const chunk = items.slice(start, start + size);
      const outcomes = await Promise.all(
        chunk.map(async (item): Promise<ItemOutcome<R>> => {
          try {
            return { ok: true, result: await runner.run(item, ctx) };
          } catch {
            return { ok: false, result: runner.failed(item) };
          }
        })
      );
      outcomes.forEach((o, i) => {
        results[start + i] = o.result;
        if (o.ok) succeeded += 1;
        else failed += 1;
      });
      await db
        .update(apiJobs)
        .set({ processedItems: start + chunk.length, succeededItems: succeeded, failedItems: failed, results: results.slice(0, start + chunk.length) })
        .where(eq(apiJobs.id, jobId));
    }

    const status: ApiJobStatus = failed === 0 ? "completed" : succeeded === 0 ? "failed" : "partially_completed";
    // JOB-1: charge the successful items at the reserved price; the rest of the hold is released.
    const charge = succeeded * pricePerItem;
    if (claimed.holdId) await commit(db, claimed.holdId, charge, claimed.operation);
    const finished = now();
    await db
      .update(apiJobs)
      .set({
        status,
        errorCode: status === "failed" ? "all_items_failed" : null,
        finishedAt: finished,
        resultsExpireAt: new Date(finished.getTime() + API_JOB_RESULTS_MS),
      })
      .where(eq(apiJobs.id, jobId));
    return status;
  } catch (err) {
    log.error("public API batch job failed", err, { jobId, operation: claimed.operation });
    await release(db, claimed.holdId).catch(() => undefined);
    const finished = now();
    await db
      .update(apiJobs)
      .set({ status: "failed", errorCode: "internal_error", finishedAt: finished, resultsExpireAt: new Date(finished.getTime() + API_JOB_RESULTS_MS) })
      .where(and(eq(apiJobs.id, jobId), inArray(apiJobs.status, ["queued", "running"])));
    return "failed";
  }
}
