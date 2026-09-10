import type { Db } from "./client.js";
import { evidenceLedger } from "./schema/evidence.js";

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
 * §5.3 (Enterprise Completion Plan) — the Evidence Ledger's write path, deliberately living at
 * the @skout/db level rather than inside one app's services. apps/api (next-best-action
 * suggestions, enrichment auto-fill) and apps/crm (CompaniesService/ContactsService auto-fill)
 * are separately deployed services sharing one Postgres, and both need to dual-write provenance
 * into this one shared table without a cross-service HTTP call — the same reasoning already
 * documented for why field-sources.ts's merge logic lives in @skout/shared rather than one app.
 *
 * `source`, `observedAt` and `confidence` are required at the type level so no caller can skip
 * provenance, per §6.1's anti-hallucination contract (packages/shared's evidence-contract.ts is
 * the read-side counterpart that enforces this on API responses).
 *
 * apps/api/src/services/evidence.service.ts re-exports this so its existing route/service
 * imports (`./evidence.service.js`) keep working unchanged; new callers, including apps/crm,
 * should import it directly from "@skout/db".
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
