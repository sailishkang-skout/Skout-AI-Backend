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

// ── SS-05 — "why this account" evidence panel ───────────────────────────────────
//
// Confidence/freshness tiers so the UI can visually distinguish trustworthy evidence from
// evidence that's shaky or about to lapse, without re-deriving thresholds client-side.

export type EvidenceConfidenceTier = "high" | "medium" | "low";
export type EvidenceFreshnessStatus = "fresh" | "expiring_soon" | "expired" | "no_expiry";

/** confidence >= this is "high"; below LOW_CONFIDENCE_THRESHOLD is "low"; between is "medium". */
export const HIGH_CONFIDENCE_THRESHOLD = 0.8;
export const LOW_CONFIDENCE_THRESHOLD = 0.5;
/** Evidence expiring within this many days of "now" is flagged "expiring_soon", not just "fresh". */
export const EXPIRING_SOON_WINDOW_DAYS = 7;

export function classifyConfidence(confidence: number): EvidenceConfidenceTier {
  if (confidence >= HIGH_CONFIDENCE_THRESHOLD) return "high";
  if (confidence < LOW_CONFIDENCE_THRESHOLD) return "low";
  return "medium";
}

export function classifyFreshness(
  freshnessExpiresAt: Date | string | null | undefined,
  now: Date = new Date()
): EvidenceFreshnessStatus {
  if (!freshnessExpiresAt) return "no_expiry";
  const expiresAt = freshnessExpiresAt instanceof Date ? freshnessExpiresAt : new Date(freshnessExpiresAt);
  const msRemaining = expiresAt.getTime() - now.getTime();
  if (msRemaining <= 0) return "expired";
  if (msRemaining <= EXPIRING_SOON_WINDOW_DAYS * 86_400_000) return "expiring_soon";
  return "fresh";
}

export interface AccountEvidenceItem {
  id: string;
  attribute: string;
  value: unknown;
  source: string;
  observedAt: string;
  confidence: number;
  confidenceTier: EvidenceConfidenceTier;
  freshnessExpiresAt: string | null;
  freshnessStatus: EvidenceFreshnessStatus;
  method: string | null;
  authority: string | null;
  corroborationCount: number;
}

export interface AccountEvidenceGroup {
  attribute: string;
  /** Most recent first — the entry at index 0 is "current belief" for this attribute. */
  entries: AccountEvidenceItem[];
}

/**
 * §8.2 SS-05 — evidence backing an account's Discover score / Account 360 view, grouped by
 * attribute (e.g. "industry", "employeeCount") rather than returned as a flat list, since a
 * panel answering "why this account" reads one fact at a time. Each entry carries pre-computed
 * confidence/freshness tiers (see classifyConfidence/classifyFreshness) so the frontend doesn't
 * re-derive thresholds — it only needs to style by tier.
 */
export async function getAccountEvidence(
  db: Db,
  workspaceId: string,
  companyId: string,
  limit = 200
): Promise<AccountEvidenceGroup[]> {
  const rows = await getEvidence(db, { workspaceId, entityType: "company", entityId: companyId }, limit);

  const now = new Date();
  const byAttribute = new Map<string, AccountEvidenceItem[]>();
  for (const row of rows) {
    const item: AccountEvidenceItem = {
      id: row.id,
      attribute: row.attribute,
      value: row.value,
      source: row.source,
      observedAt: row.observedAt.toISOString(),
      confidence: row.confidence,
      confidenceTier: classifyConfidence(row.confidence),
      freshnessExpiresAt: row.freshnessExpiresAt ? row.freshnessExpiresAt.toISOString() : null,
      freshnessStatus: classifyFreshness(row.freshnessExpiresAt, now),
      method: row.method,
      authority: row.authority,
      corroborationCount: row.corroborationCount,
    };
    const existing = byAttribute.get(row.attribute);
    if (existing) existing.push(item);
    else byAttribute.set(row.attribute, [item]);
  }

  // rows already arrive observedAt-descending from getEvidence, so each group is already
  // sorted; order the groups themselves by their most recent entry's observedAt.
  return Array.from(byAttribute.entries())
    .map(([attribute, entries]) => ({ attribute, entries }))
    .sort((a, b) => b.entries[0]!.observedAt.localeCompare(a.entries[0]!.observedAt));
}
