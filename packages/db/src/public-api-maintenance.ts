import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/** PRD §10: request log rows are kept 90 days, idempotency records 24 hours. */
export const API_REQUEST_LOG_RETENTION_DAYS = 90;
export const API_IDEMPOTENCY_RETENTION_HOURS = 24;
/** Monthly request-log partitions kept ready ahead of time. */
export const API_REQUEST_LOG_MONTHS_AHEAD = 3;

export interface PublicApiMaintenanceResult {
  partitionsCreated: number;
  partitionsDropped: string[];
  idempotencyPurged: number;
}

/**
 * PAPI-012 housekeeping, run on a schedule by the API's public-api-maintenance worker:
 * - creates request-log partitions for this month and the next three,
 * - drops request-log partitions whose whole month is older than 90 days,
 * - deletes idempotency records older than 24 hours.
 * Safe to run repeatedly and from several instances.
 */
export async function maintainPublicApiTables(db: Db, now: Date = new Date()): Promise<PublicApiMaintenanceResult> {
  const iso = now.toISOString();
  const created = await db.execute(
    sql`select api_request_log_ensure_partitions(${iso}::timestamptz, ${API_REQUEST_LOG_MONTHS_AHEAD}) as n`
  );
  const dropped = await db.execute(
    sql`select api_request_log_drop_partitions_before(${iso}::timestamptz - make_interval(days => ${API_REQUEST_LOG_RETENTION_DAYS})) as name`
  );
  const purged = await db.execute(
    sql`delete from api_idempotency where created_at < ${iso}::timestamptz - make_interval(hours => ${API_IDEMPOTENCY_RETENTION_HOURS}) returning 1`
  );
  return {
    partitionsCreated: Number((created as unknown as Array<{ n: number }>)[0]?.n ?? 0),
    partitionsDropped: (dropped as unknown as Array<{ name: string }>).map((r) => r.name),
    idempotencyPurged: (purged as unknown as unknown[]).length,
  };
}
