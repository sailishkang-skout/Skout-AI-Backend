import { and, eq, inArray, isNull, lt, or, type InferSelectModel, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@skout/db";
import type { ExecutionIntentTable } from "./types.js";
import { MAX_ATTEMPTS } from "./retry-policy.js";

export interface ReclaimResult {
  requeuedIds: string[];
  failedIds: string[];
}

/**
 * Returns every claimed/running row whose lease has expired back to pending — or to failed if
 * it has already hit MAX_ATTEMPTS. Intended to run once per poll tick from each adopter's own
 * worker loop, mirroring Warm-Up-Tool's "reclaim is step 1 of every scheduler tick" design
 * rather than a standalone reaper process.
 *
 * Returns row ids (not counts) so a caller can look up whatever domain-specific parent record it
 * needs (e.g. an automation run) to react to the reclaim — the library itself stays domain-
 * agnostic and doesn't know what a "run" is.
 *
 * A row whose lease_expires_at is NULL (never set, or cleared without a status transition) is
 * treated as expired too — in SQL, `NULL < now()` evaluates to NULL, not true, so without the
 * explicit `isNull` branch such a row would be invisible to this sweep forever.
 *
 * `extraWhere` lets a caller scope the sweep to its own domain slice (mirroring claim.ts's
 * `claimNext`) instead of sweeping the entire table — important in a shared dev/test database
 * where an unscoped sweep could mutate unrelated rows. It's applied to the initial SELECT only;
 * the per-row UPDATE is already scoped to a specific `id` pulled from that scoped SELECT, so
 * re-applying `extraWhere` there would be redundant (same pattern claim.ts follows for its own
 * per-row UPDATE).
 *
 * The `as PgTable`/`Partial<InferSelectModel<T>>` casts mirror claim.ts's and heartbeat.ts's
 * documented trade-off: Drizzle's generics don't fully propagate a runtime-parameterized table's
 * exact column types through `.from()`/`.update()`/`.set()` chains (verified against
 * drizzle-orm 0.44.7). Every value being cast is still a real Drizzle-safe table/column/value
 * object, never a string or identifier, so this never reopens the raw-SQL/identifier-
 * interpolation risk the design was revised to avoid.
 *
 * The per-row re-check in the UPDATE's WHERE clause (status still claimed/running, lease still
 * expired-or-null) guards against a race between the SELECT and this row's UPDATE: if another
 * caller (a concurrent reclaim sweep, or the original worker heartbeating back in) already
 * renewed or completed the row in between, the UPDATE affects zero rows and this function skips
 * counting it instead of clobbering that newer state.
 */
export async function reclaimExpiredLeases<T extends ExecutionIntentTable>(
  db: Db,
  table: T,
  batchLimit = 100,
  extraWhere?: SQL
): Promise<ReclaimResult> {
  const now = new Date();
  const statusWhere = inArray(table.status, ["claimed", "running"]);
  const leaseExpiredWhere = or(lt(table.leaseExpiresAt, now), isNull(table.leaseExpiresAt));
  const selectWhere = extraWhere ? and(statusWhere, leaseExpiredWhere, extraWhere) : and(statusWhere, leaseExpiredWhere);

  const expired = await db
    .select({ id: table.id, attemptCount: table.attemptCount })
    .from(table as PgTable)
    .where(selectWhere)
    .limit(batchLimit);

  const requeuedIds: string[] = [];
  const failedIds: string[] = [];
  for (const row of expired) {
    const nextStatus = (row.attemptCount as number) >= MAX_ATTEMPTS ? "failed" : "pending";
    const updated = await db
      .update(table as PgTable)
      .set({ status: nextStatus, leaseOwner: null, leaseExpiresAt: null } as Partial<InferSelectModel<T>>)
      .where(and(eq(table.id, row.id as string), statusWhere, leaseExpiredWhere))
      .returning({ id: table.id });
    if (updated.length === 0) continue; // reclaimed or completed by someone else between select and update
    if (nextStatus === "failed") failedIds.push(row.id as string);
    else requeuedIds.push(row.id as string);
  }
  return { requeuedIds, failedIds };
}
