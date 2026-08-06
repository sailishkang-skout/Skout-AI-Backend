import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";

const { signals } = schema;

export interface SignalRecord {
  id: string;
  entityType: string;
  entityId: string;
  signalType: string;
  value: Record<string, unknown>;
  confidence: number | null;
  detectedAt: string;
  source: string | null;
  provenance: Record<string, unknown>;
  createdAt: string;
}

function serialize(row: typeof signals.$inferSelect): SignalRecord {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    signalType: row.signalType,
    value: row.value as Record<string, unknown>,
    confidence: row.confidence,
    detectedAt: row.detectedAt.toISOString(),
    source: row.source,
    provenance: row.provenance as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ListSignalsOptions {
  entityType?: string;
  signalType?: string;
  limit?: number;
}

/** Normalized, chronological (oldest → newest) timeline of every signal for an entity. */
export async function listSignalsForEntity(
  db: Db,
  entityId: string,
  opts: ListSignalsOptions = {}
): Promise<SignalRecord[]> {
  const conditions = [eq(signals.entityId, entityId)];
  if (opts.entityType) conditions.push(eq(signals.entityType, opts.entityType));
  if (opts.signalType) conditions.push(eq(signals.signalType, opts.signalType));

  const rows = await db
    .select()
    .from(signals)
    .where(and(...conditions))
    .orderBy(asc(signals.detectedAt))
    .limit(opts.limit ?? 100);

  return rows.map(serialize);
}
