import { and, eq, inArray, lt, type InferSelectModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@skout/db";
import type { ExecutionIntentTable } from "./types.js";
import { MAX_ATTEMPTS } from "./retry-policy.js";

export interface ReclaimResult {
  requeued: number;
  failed: number;
}

/**
 * Returns every claimed/running row whose lease has expired back to pending — or to failed if
 * it has already hit MAX_ATTEMPTS. Intended to run once per poll tick from each adopter's own
 * worker loop, mirroring Warm-Up-Tool's "reclaim is step 1 of every scheduler tick" design
 * rather than a standalone reaper process.
 *
 * The `as PgTable`/`Partial<InferSelectModel<T>>` casts mirror claim.ts's and heartbeat.ts's
 * documented trade-off: Drizzle's generics don't fully propagate a runtime-parameterized table's
 * exact column types through `.from()`/`.update()`/`.set()` chains (verified against
 * drizzle-orm 0.44.7). Every value being cast is still a real Drizzle-safe table/column/value
 * object, never a string or identifier, so this never reopens the raw-SQL/identifier-
 * interpolation risk the design was revised to avoid.
 *
 * The per-row re-check in the UPDATE's WHERE clause (status still claimed/running, lease still
 * expired) guards against a race between the SELECT and this row's UPDATE: if another caller
 * (a concurrent reclaim sweep, or the original worker heartbeating back in) already renewed or
 * completed the row in between, the UPDATE affects zero rows and this function skips counting it
 * instead of clobbering that newer state.
 */
export async function reclaimExpiredLeases<T extends ExecutionIntentTable>(
  db: Db,
  table: T,
  batchLimit = 100
): Promise<ReclaimResult> {
  const now = new Date();
  const expired = await db
    .select({ id: table.id, attemptCount: table.attemptCount })
    .from(table as PgTable)
    .where(and(inArray(table.status, ["claimed", "running"]), lt(table.leaseExpiresAt, now)))
    .limit(batchLimit);

  let requeued = 0;
  let failed = 0;
  for (const row of expired) {
    const nextStatus = (row.attemptCount as number) >= MAX_ATTEMPTS ? "failed" : "pending";
    const updated = await db
      .update(table as PgTable)
      .set({ status: nextStatus, leaseOwner: null, leaseExpiresAt: null } as Partial<InferSelectModel<T>>)
      .where(
        and(
          eq(table.id, row.id as string),
          inArray(table.status, ["claimed", "running"]),
          lt(table.leaseExpiresAt, now)
        )
      )
      .returning({ id: table.id });
    if (updated.length === 0) continue; // reclaimed or completed by someone else between select and update
    if (nextStatus === "failed") failed++;
    else requeued++;
  }
  return { requeued, failed };
}
