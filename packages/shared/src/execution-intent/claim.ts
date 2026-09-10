import { and, asc, eq, sql, type InferSelectModel, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@skout/db";
import type { ExecutionIntentTable } from "./types.js";

/**
 * Claims the oldest pending row on `table`, atomically transitioning it to "claimed" and
 * incrementing attemptCount. Uses a transaction with SELECT ... FOR UPDATE SKIP LOCKED so two
 * concurrent callers can never claim the same row — Drizzle's typed `.for()` API, not raw SQL.
 * `extraWhere` lets a domain add its own claimability predicate (e.g. a scheduled-for check)
 * without the library needing to know about domain-specific columns.
 *
 * The `as PgTable` casts on `table` at the `.from()`/`.update()` call sites, and the
 * `Partial<InferSelectModel<T>>`/`InferSelectModel<T>` casts around `.set()`/the return value,
 * are a deliberate, narrow trade-off: Drizzle's generics don't fully propagate a
 * runtime-parameterized table's exact column types through `.from()`/`.set()`/`.returning()`
 * chains (verified against drizzle-orm 0.44.7). Every value being cast is still a real
 * Drizzle-safe table/column/value object — never a string or identifier — so this never reopens
 * the raw-SQL/identifier-interpolation risk the design was revised to avoid.
 */
export async function claimNext<T extends ExecutionIntentTable>(
  db: Db,
  table: T,
  workerId: string,
  leaseDurationMs: number,
  extraWhere?: SQL
): Promise<InferSelectModel<T> | undefined> {
  return db.transaction(async (tx) => {
    const pendingWhere = eq(table.status, "pending");
    const candidateWhere = extraWhere ? and(pendingWhere, extraWhere) : pendingWhere;

    const [candidate] = await tx
      .select({ id: table.id })
      .from(table as PgTable)
      .where(candidateWhere)
      .orderBy(asc(table.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return undefined;

    const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);
    const [claimed] = await tx
      .update(table as PgTable)
      .set({
        status: "claimed",
        leaseOwner: workerId,
        leaseExpiresAt,
        attemptCount: sql`${table.attemptCount} + 1`,
      } as Partial<InferSelectModel<T>>)
      .where(eq(table.id, candidate.id))
      .returning();
    return claimed as InferSelectModel<T>;
  });
}
