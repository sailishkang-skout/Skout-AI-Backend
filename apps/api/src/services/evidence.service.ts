import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, recordEvidence, type RecordEvidenceInput } from "@skout/db";

const { evidenceLedger } = schema;

/**
 * §5.3 (Enterprise Completion Plan) — the write path itself now lives in @skout/db
 * (packages/db/src/evidence-writer.ts) so apps/crm can dual-write into the same ledger without
 * a cross-service HTTP call to apps/api. Re-exported here so every existing import of
 * `recordEvidence`/`RecordEvidenceInput` from "./evidence.service.js" (evidence.routes.ts,
 * next-best-action.service.ts, enrichment-autofill.service.ts) keeps working unchanged.
 */
export { recordEvidence, type RecordEvidenceInput };

export interface GetEvidenceQuery {
  workspaceId: string;
  entityType: string;
  entityId: string;
  attribute?: string;
}

/** Most recent evidence first, so callers naturally get "current belief" at index 0. */
export async function getEvidence(db: Db, query: GetEvidenceQuery, limit = 20) {
  const conditions = [
    eq(evidenceLedger.workspaceId, query.workspaceId),
    eq(evidenceLedger.entityType, query.entityType),
    eq(evidenceLedger.entityId, query.entityId),
  ];
  if (query.attribute) conditions.push(eq(evidenceLedger.attribute, query.attribute));

  return db
    .select()
    .from(evidenceLedger)
    .where(and(...conditions))
    .orderBy(desc(evidenceLedger.observedAt))
    .limit(limit);
}
