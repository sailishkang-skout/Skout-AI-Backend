import { and, eq, inArray, type InferSelectModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@skout/db";
import type { ExecutionIntentTable, ExecutionIntentStatus } from "./types.js";

export class LeaseLostError extends Error {
  constructor(intentId: string) {
    super(`Execution intent ${intentId}'s lease is no longer held — it may have expired or been reassigned`);
    this.name = "LeaseLostError";
  }
}

export interface RecordResultInput {
  status: ExecutionIntentStatus;
  [key: string]: unknown;
}

/**
 * Unified complete/fail/requeue transition, lease-gated: only succeeds if `workerId` still holds
 * the lease on a row currently claimed/running. Always releases the lease on success, regardless
 * of the resulting status — retry delay is the caller's responsibility (re-enqueue a delayed job),
 * not something this library tracks on the row itself.
 *
 * The `as PgTable`/`Partial<InferSelectModel<T>>` casts mirror claim.ts's, heartbeat.ts's, and
 * reclaim.ts's documented trade-off: Drizzle's generics don't fully propagate a
 * runtime-parameterized table's exact column types through `.update()`/`.set()` chains (verified
 * against drizzle-orm 0.44.7). Every value being cast is still a real Drizzle-safe table/column/
 * value object, never a string or identifier, so this never reopens the raw-SQL/identifier-
 * interpolation risk the design was revised to avoid.
 */
export async function recordResult<T extends ExecutionIntentTable>(
  db: Db,
  table: T,
  intentId: string,
  workerId: string,
  input: RecordResultInput
): Promise<InferSelectModel<T>> {
  const [row] = await db
    .update(table as PgTable)
    .set({ ...input, leaseOwner: null, leaseExpiresAt: null } as Partial<InferSelectModel<T>>)
    .where(and(eq(table.id, intentId), eq(table.leaseOwner, workerId), inArray(table.status, ["claimed", "running"])))
    .returning();
  if (!row) throw new LeaseLostError(intentId);
  return row as InferSelectModel<T>;
}
