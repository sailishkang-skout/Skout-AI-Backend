import type { FieldSourcesMap } from "./field-sources.js";

export interface FieldProvenanceEntry {
  field: string;
  source: string;
  confidence: number | null;
  observedAt: string;
  /** Present only when this entry was sourced from the evidence_ledger, not the fieldSources fallback. */
  evidenceId?: string;
  origin: "evidence_ledger" | "field_sources";
}

/** Minimal shape this function needs from an evidence_ledger row - matches
 * packages/db/src/evidence-reader.ts's LatestEvidenceRow without importing @skout/db from
 * @skout/shared (this package has no DB dependency by design). */
export interface EvidenceRowForProvenance {
  id: string;
  source: string;
  confidence: number;
  observedAt: string;
}

/**
 * §5.3 Task 37 (Enterprise Completion Plan) — the additive read-path adapter for CRM field
 * provenance. Merges the canonical Evidence Ledger over the cheaper `fieldSources` jsonb map
 * this codebase already had (see field-sources.ts's own doc comment): a field with a matching
 * evidence_ledger row uses that (richer: real confidence, real observedAt, a real evidenceId to
 * look up the full row via GET /evidence); a field with no evidence_ledger row yet - because it
 * predates the dual-write added to ContactsService/CompaniesService/DealsService.autoFill, or
 * because that best-effort write failed - falls back to its fieldSources entry, translated into
 * the same shape.
 *
 * Deliberately NOT a hard cutover for writes: fieldSources remains a transitional write cache,
 * but autofill precedence (filterAutoFillablePatch) now consults evidence_ledger manual locks
 * when provided (Wave 2). This function never writes anything — read view only.
 */
export function buildFieldProvenance(
  fieldSources: FieldSourcesMap,
  evidenceByAttribute: Record<string, EvidenceRowForProvenance>
): Record<string, FieldProvenanceEntry> {
  const fields = new Set<string>([...Object.keys(fieldSources), ...Object.keys(evidenceByAttribute)]);
  const result: Record<string, FieldProvenanceEntry> = {};

  for (const field of fields) {
    const evidence = evidenceByAttribute[field];
    if (evidence) {
      result[field] = {
        field,
        source: evidence.source,
        confidence: evidence.confidence,
        observedAt: evidence.observedAt,
        evidenceId: evidence.id,
        origin: "evidence_ledger",
      };
      continue;
    }

    const fallback = fieldSources[field];
    if (fallback) {
      result[field] = {
        field,
        source: fallback.source,
        confidence: fallback.confidence ?? null,
        observedAt: fallback.setAt,
        origin: "field_sources",
      };
    }
  }

  return result;
}
