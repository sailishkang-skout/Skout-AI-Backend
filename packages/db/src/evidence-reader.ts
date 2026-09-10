import { desc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { evidenceLedger } from "./schema/evidence.js";
import { scopedTo } from "./tenant-scope.js";

export interface LatestEvidenceRow {
  id: string;
  attribute: string;
  source: string;
  confidence: number;
  observedAt: string;
}

/**
 * §5.3 Task 37 (Enterprise Completion Plan) — the read-side counterpart to recordEvidence
 * (evidence-writer.ts), living at the same @skout/db level for the same cross-service reason:
 * apps/api and apps/crm are separately deployed services sharing one Postgres, and both need to
 * read the Evidence Ledger without a cross-service HTTP call.
 *
 * Returns at most one row per attribute — the most recently observed evidence_ledger entry for
 * that (workspaceId, entityType, entityId, attribute) triple. Rows are fetched in
 * observedAt-descending order and reduced to first-seen-per-attribute in application code
 * rather than a SQL DISTINCT ON query: evidence rows per CRM record are a small, bounded set in
 * practice (auto-fill events on one contact/company/deal), not a hot path that needs SQL-level
 * dedup, and this keeps the query portable across the driver setup already used elsewhere in
 * this package. The LIMIT is a defensive cap, not a correctness assumption - if it's ever hit,
 * some attributes may fall back to field_sources for this call even though newer evidence
 * exists further back, which is the same "fall back to a slightly stale source" behavior the
 * caller already has to handle for entities with zero evidence rows at all.
 */
export async function getLatestEvidenceByAttribute(
  db: Db,
  workspaceId: string,
  entityType: string,
  entityId: string
): Promise<Record<string, LatestEvidenceRow>> {
  const rows = await db
    .select({
      id: evidenceLedger.id,
      attribute: evidenceLedger.attribute,
      source: evidenceLedger.source,
      confidence: evidenceLedger.confidence,
      observedAt: evidenceLedger.observedAt,
    })
    .from(evidenceLedger)
    .where(scopedTo(evidenceLedger, workspaceId, eq(evidenceLedger.entityType, entityType), eq(evidenceLedger.entityId, entityId)))
    .orderBy(desc(evidenceLedger.observedAt))
    .limit(500);

  const result: Record<string, LatestEvidenceRow> = {};
  for (const row of rows) {
    if (result[row.attribute]) continue; // already have a newer row for this attribute
    result[row.attribute] = {
      id: row.id,
      attribute: row.attribute,
      source: row.source,
      confidence: row.confidence,
      observedAt: row.observedAt.toISOString(),
    };
  }
  return result;
}
