import { and, asc, desc, eq, inArray } from "drizzle-orm";
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

/** Lightweight overlay payload for list/TAM/search rows (R11.3). */
export interface OverlaySignal {
  type: string;
  observedAt: string;
  detail?: string;
}

const OVERLAY_PER_ENTITY = 8;

/** Batch-load signal timelines for many entity ids (prospect + company) in one query. */
export async function listSignalsForEntities(db: Db, entityIds: string[]): Promise<Map<string, SignalRecord[]>> {
  const ids = [...new Set(entityIds.filter((id) => id.length > 0))];
  if (ids.length === 0) return new Map();

  const rows = await db
    .select()
    .from(signals)
    .where(inArray(signals.entityId, ids))
    .orderBy(desc(signals.detectedAt));

  const map = new Map<string, SignalRecord[]>();
  for (const row of rows) {
    const list = map.get(row.entityId) ?? [];
    if (list.length >= OVERLAY_PER_ENTITY) continue;
    list.push(serialize(row));
    map.set(row.entityId, list);
  }
  return map;
}

function overlayDetail(value: Record<string, unknown>): string | undefined {
  for (const key of ["reason", "detail", "tool", "technology"]) {
    const v = value[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Merge prospect + company signals, newest first, cap at `max` (default 3). */
export function overlaySignalsForMember(
  byEntity: Map<string, SignalRecord[]>,
  prospectId: string,
  companyId: string,
  max = 3
): OverlaySignal[] {
  const merged = [
    ...(byEntity.get(prospectId) ?? []),
    ...(companyId && companyId !== prospectId ? (byEntity.get(companyId) ?? []) : []),
  ];
  const seen = new Set<string>();
  const unique: SignalRecord[] = [];
  for (const signal of merged) {
    const key = `${signal.signalType}:${signal.detectedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(signal);
  }
  unique.sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime());
  return unique.slice(0, max).map((signal) => {
    const detail = overlayDetail(signal.value);
    return {
      type: signal.signalType,
      observedAt: signal.detectedAt,
      ...(detail ? { detail } : {}),
    };
  });
}

export interface RecordSignalInput {
  entityType?: string;
  entityId: string;
  signalType: string;
  /** Plain-language explanation — required for risk-type signals (R18.1/R18.2 AC2), optional otherwise. */
  reason?: string;
  score?: number;
  confidence?: number;
  detectedAt?: Date;
  source?: string;
}

/**
 * Write a signal from apps/api itself (as opposed to the corpus ingestor's `recordSignals` in
 * workers/scrapers/ingestor). Used by workspace-local signal producers — the risk-decay sweep
 * (R18.1), reply-derived risk detection (R18.2) — that don't have a corpus crawl to hang off of.
 */
export async function recordSignal(db: Db, input: RecordSignalInput): Promise<SignalRecord> {
  const [row] = await db
    .insert(signals)
    .values({
      entityType: input.entityType ?? "prospect",
      entityId: input.entityId,
      signalType: input.signalType,
      value: {
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.score !== undefined ? { score: input.score } : {}),
      },
      confidence: input.confidence ?? null,
      detectedAt: input.detectedAt ?? new Date(),
      source: input.source ?? null,
    })
    .returning();
  return serialize(row!);
}
