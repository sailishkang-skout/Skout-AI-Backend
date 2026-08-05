import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Signal } from "@skout/scraper-contracts";

/** Persist typed signals into the unified signal store (R11.2). */
export async function recordSignals(db: Db, entityId: string, signals: Signal[]): Promise<void> {
  if (!signals.length) return;
  try {
    await db.insert(schema.signals).values(
      signals.map((signal) => ({
        entityType: "company",
        entityId,
        signalType: signal.type,
        value: { detail: signal.detail ?? null },
        detectedAt: new Date(signal.observedAt),
        source: signal.source ?? null,
        provenance: signal.source ? { source: signal.source } : {},
      }))
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/relation "signals" does not exist/i.test(message)) {
      console.warn("[ingestor] signals table missing — run migration 0028. Skipping signal insert.");
      return;
    }
    throw err;
  }
}
