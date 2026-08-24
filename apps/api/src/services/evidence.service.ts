import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";

const { evidenceLedger } = schema;

export interface RecordEvidenceInput {
  workspaceId: string;
  entityType: string;
  entityId: string;
  attribute: string;
  value: unknown;
  source: string;
  observedAt: Date;
  /** Required — no evidence row may exist without a confidence value (§6.1 anti-hallucination contract). */
  confidence: number;
  method?: string;
  region?: string;
  authority?: string;
  corroborationCount?: number;
  validation?: string;
  freshnessExpiresAt?: Date;
  chosenValue?: unknown;
  resolutionRuleOrModelVersion?: string;
  alternatives?: unknown;
  resolutionReason?: string;
  reviewerId?: string;
  permittedPurpose?: string;
  consentBasis?: string;
  channelConstraints?: unknown;
  retentionUntil?: Date;
}

/**
 * §5.3 (Enterprise Completion Plan) — the Evidence Ledger's write API. `source`, `observedAt`
 * and `confidence` are required at the type level so no caller can skip provenance, per §6.1's
 * anti-hallucination contract (packages/shared's evidence-contract.ts is the read-side
 * counterpart that enforces this on API responses).
 */
export async function recordEvidence(db: Db, input: RecordEvidenceInput) {
  const [row] = await db
    .insert(evidenceLedger)
    .values({
      workspaceId: input.workspaceId,
      entityType: input.entityType,
      entityId: input.entityId,
      attribute: input.attribute,
      value: input.value as object,
      source: input.source,
      observedAt: input.observedAt,
      confidence: input.confidence,
      method: input.method,
      region: input.region,
      authority: input.authority,
      corroborationCount: input.corroborationCount ?? 1,
      validation: input.validation,
      freshnessExpiresAt: input.freshnessExpiresAt,
      chosenValue: input.chosenValue as object | undefined,
      resolutionRuleOrModelVersion: input.resolutionRuleOrModelVersion,
      alternatives: input.alternatives as object | undefined,
      resolutionReason: input.resolutionReason,
      reviewerId: input.reviewerId,
      permittedPurpose: input.permittedPurpose,
      consentBasis: input.consentBasis,
      channelConstraints: input.channelConstraints as object | undefined,
      retentionUntil: input.retentionUntil,
    })
    .returning();
  return row;
}

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
