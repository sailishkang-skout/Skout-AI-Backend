import { and, eq, gt, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import type { ApiPriceOperation } from "@skout/shared";
import { commit, release, reserve } from "./api-credits.service.js";
import type { CreditCaps } from "./api-limits.service.js";

const { apiDatumCache } = schema;

/**
 * The 30-day cache-hit rule (PAPI-034, public API PRD CRED-4): if a workspace was already charged for
 * the same datum (same subject, same datum type) in the last 30 days, it gets it again for free.
 * The window runs from the last *charged* delivery; free repeats never extend it.
 */
export const DATUM_CACHE_WINDOW_MS = 30 * 86_400_000;
export type DatumType = "email" | "phone" | "person" | "company" | "company_jobs" | "search_page";

export async function getCachedDatum<T>(
  db: Db,
  workspaceId: string,
  subjectKey: string,
  type: DatumType,
  now = new Date(),
  windowMs = DATUM_CACHE_WINDOW_MS
): Promise<T | null> {
  const [row] = await db
    .select({ value: apiDatumCache.value })
    .from(apiDatumCache)
    .where(
      and(
        eq(apiDatumCache.workspaceId, workspaceId),
        eq(apiDatumCache.subjectKey, subjectKey),
        eq(apiDatumCache.datumType, type),
        gt(apiDatumCache.deliveredAt, new Date(now.getTime() - windowMs))
      )
    )
    .limit(1);
  return row ? (row.value as T) : null;
}

/** Records a charged delivery, starting a fresh 30-day window. */
export async function recordChargedDatum(db: Db, workspaceId: string, subjectKey: string, type: DatumType, value: unknown, now = new Date()): Promise<void> {
  await db
    .insert(apiDatumCache)
    .values({ workspaceId, subjectKey, datumType: type, value, deliveredAt: now })
    .onConflictDoUpdate({
      target: [apiDatumCache.workspaceId, apiDatumCache.subjectKey, apiDatumCache.datumType],
      set: { value, deliveredAt: now },
    });
}

/** DSAR (PRD §9.6): removes a subject from every workspace's cache. Returns the rows removed. */
export async function forgetSubject(db: Db, subjectKey: string): Promise<number> {
  const rows = await db.delete(apiDatumCache).where(eq(apiDatumCache.subjectKey, subjectKey)).returning({ w: apiDatumCache.workspaceId });
  return rows.length;
}

export interface BillableDatumInput<T> {
  workspaceId: string;
  apiKeyId: string;
  requestId: string;
  subjectKey: string;
  type: DatumType;
  operation: ApiPriceOperation;
  /** The current price (priceFor), charged only when `fetch` finds the datum. */
  price: number;
  caps?: CreditCaps;
  /** Calls the provider/service; null means "not found" (charged 0). */
  fetch: () => Promise<T | null>;
}

export interface BillableDatumResult<T> {
  value: T | null;
  charged: number;
  cacheHit: boolean;
}

/**
 * The billing path for one datum (CRED-2, CRED-4): a cache hit is returned at no charge and with no
 * hold; otherwise the price is reserved, the datum fetched, then the charge committed (found) or the
 * hold released (not found, or an error, which is rethrown).
 */
export async function deliverBillableDatum<T>(db: Db, input: BillableDatumInput<T>, now = new Date()): Promise<BillableDatumResult<T>> {
  const cached = await getCachedDatum<T>(db, input.workspaceId, input.subjectKey, input.type, now);
  if (cached !== null) return { value: cached, charged: 0, cacheHit: true };

  const hold = await reserve(db, { workspaceId: input.workspaceId, apiKeyId: input.apiKeyId, requestId: input.requestId, max: input.price, caps: input.caps }, now);
  let value: T | null;
  try {
    value = await input.fetch();
  } catch (err) {
    await release(db, hold.holdId);
    throw err;
  }
  if (value === null) {
    await release(db, hold.holdId);
    return { value: null, charged: 0, cacheHit: false };
  }
  const result = await commit(db, hold.holdId, input.price, input.operation);
  await recordChargedDatum(db, input.workspaceId, input.subjectKey, input.type, value, now);
  return { value, charged: result.charged, cacheHit: false };
}

/** Rows currently cached for a workspace (for tests and support). */
export async function cachedDatumCount(db: Db, workspaceId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(apiDatumCache).where(eq(apiDatumCache.workspaceId, workspaceId));
  return r?.n ?? 0;
}
