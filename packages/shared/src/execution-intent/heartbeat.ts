import { and, eq, gt, type InferSelectModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@skout/db";
import type { ExecutionIntentTable } from "./types.js";

const HEARTBEAT_INTERVAL_FRACTION = 3; // renew every 1/3 of the lease duration

/** Extends the lease if — and only if — `workerId` is still the current owner and the lease
 * has not already expired. Returns false (never throws) so a caller can log-and-continue;
 * the definitive signal that a lease was truly lost is recordResult's LeaseLostError.
 *
 * The `as PgTable`/`Partial<InferSelectModel<T>>` casts mirror claim.ts's documented trade-off:
 * Drizzle's generics don't fully propagate a runtime-parameterized table's exact column types
 * through `.update()`/`.set()` chains (verified against drizzle-orm 0.44.7). Every value being
 * cast is still a real Drizzle-safe table/column/value object, never a string or identifier. */
export async function renewLease<T extends ExecutionIntentTable>(
  db: Db,
  table: T,
  intentId: string,
  workerId: string,
  leaseDurationMs: number
): Promise<boolean> {
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);
  const rows = await db
    .update(table as PgTable)
    .set({ leaseExpiresAt } as Partial<InferSelectModel<T>>)
    .where(and(eq(table.id, intentId), eq(table.leaseOwner, workerId), gt(table.leaseExpiresAt, new Date())))
    .returning({ id: table.id });
  return rows.length > 0;
}

/** Wraps a unit of work in periodic lease renewal so a long-running claim survives past its
 * initial lease duration without being reclaimed out from under the worker mid-execution. */
export async function withLeaseHeartbeat<T extends ExecutionIntentTable, R>(
  db: Db,
  table: T,
  intentId: string,
  workerId: string,
  leaseDurationMs: number,
  work: () => Promise<R>
): Promise<R> {
  const intervalMs = Math.max(1_000, Math.floor(leaseDurationMs / HEARTBEAT_INTERVAL_FRACTION));
  const timer = setInterval(() => {
    renewLease(db, table, intentId, workerId, leaseDurationMs).catch(() => {
      // best-effort — a failed renewal surfaces later as recordResult's LeaseLostError
    });
  }, intervalMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
