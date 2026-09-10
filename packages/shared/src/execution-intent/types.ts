import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

export type ExecutionIntentStatus =
  | "pending"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "outcome_unknown";

/** Structural contract a domain's own Drizzle table must satisfy to use this library — every
 * function here operates on real column objects from this table, never a string-keyed map, so
 * there is no raw-SQL/identifier-interpolation surface anywhere in this package. */
export interface ExecutionIntentTable extends PgTable {
  id: PgColumn;
  status: PgColumn;
  leaseOwner: PgColumn;
  leaseExpiresAt: PgColumn;
  attemptCount: PgColumn;
  createdAt: PgColumn;
}
