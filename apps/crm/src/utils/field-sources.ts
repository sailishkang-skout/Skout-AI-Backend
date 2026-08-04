/**
 * R13.3 — Auto-filled CRM/contact fields.
 *
 * Shared logic for `contacts.fieldSources` / `companies.fieldSources` (jsonb column added in
 * drizzle/0028_crm_field_sources.sql). Each field a record can have gets an entry:
 *   { source: "manual" | "enrichment" | "meeting_bot" | "call_note", confidence?: number, setAt: string }
 *
 * Rule (per phase-1-feature-work-plan.md R13.3 acceptance criteria):
 *   - Auto-fill (source != "manual") may set a field if it's unset OR was previously set by
 *     another auto-fill source — auto-fill sources may refresh each other.
 *   - The moment a human edits a field via the normal PATCH endpoint, its source flips to
 *     "manual" and no later auto-fill may touch it again.
 */

export type FieldSource = "manual" | "enrichment" | "meeting_bot" | "call_note";

export interface FieldSourceEntry {
  source: FieldSource;
  confidence?: number;
  setAt: string;
}

export type FieldSourcesMap = Record<string, FieldSourceEntry>;

export function asFieldSourcesMap(value: unknown): FieldSourcesMap {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as FieldSourcesMap;
  }
  return {};
}

/** Fields in `patch` whose current provenance is "manual" are dropped — auto-fill can't touch them. */
export function filterAutoFillablePatch<T extends object>(
  patch: T,
  existingSources: FieldSourcesMap
): { applied: Partial<T>; skipped: string[] } {
  const applied: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    const existing = existingSources[key];
    if (existing?.source === "manual") {
      skipped.push(key);
      continue;
    }
    applied[key] = value;
  }
  return { applied: applied as Partial<T>, skipped };
}

/** Merge new provenance entries for the fields that were actually applied by an auto-fill call. */
export function mergeAutoFillSources(
  existingSources: FieldSourcesMap,
  appliedFields: string[],
  source: FieldSource,
  confidence: number | undefined
): FieldSourcesMap {
  const setAt = new Date().toISOString();
  const next: FieldSourcesMap = { ...existingSources };
  for (const field of appliedFields) {
    next[field] = { source, confidence, setAt };
  }
  return next;
}

/** Mark fields a human just edited (via the normal update endpoint) as "manual" forever. */
export function markManualSources(existingSources: FieldSourcesMap, editedFields: string[]): FieldSourcesMap {
  const setAt = new Date().toISOString();
  const next: FieldSourcesMap = { ...existingSources };
  for (const field of editedFields) {
    next[field] = { source: "manual", setAt };
  }
  return next;
}
