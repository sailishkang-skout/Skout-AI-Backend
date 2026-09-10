import type { RecordEvidenceInput } from "@skout/db";

/**
 * Maps Skout-Email-Intelligence-Tool's evidence_ledger row shape onto the
 * canonical workspace-scoped Evidence Ledger (§5.3 merge path).
 *
 * Email-Intel has no workspaceId — the caller supplies it (ingest route or
 * verify dual-write). entityId defaults to the email address.
 */
export interface EmailIntelEvidenceObservation {
  email: string;
  domain?: string | null;
  source: string;
  outcome: string;
  responseCode?: number | null;
  responseMessage?: string | null;
  smtpValid?: boolean | null;
  mailboxExists?: boolean | null;
  catchAll?: boolean | null;
  provider?: string | null;
  verificationId?: string | null;
  requestId?: string | null;
  metadata?: unknown;
  rawEvidence?: unknown;
  createdAt?: string | Date | null;
  externalId?: string | null;
}

export function mapEmailIntelObservationToCanonical(
  workspaceId: string,
  obs: EmailIntelEvidenceObservation
): RecordEvidenceInput {
  const outcome = (obs.outcome || "").toUpperCase();
  const confidence =
    outcome === "SUCCESS" ? 0.9 : outcome === "FAILURE" ? 0.85 : outcome === "TEMPORARY" ? 0.4 : 0.5;

  const observedAt =
    obs.createdAt instanceof Date
      ? obs.createdAt
      : obs.createdAt
        ? new Date(obs.createdAt)
        : new Date();

  return {
    workspaceId,
    entityType: "email",
    entityId: obs.email.toLowerCase(),
    attribute: "deliverability_observation",
    value: {
      email: obs.email,
      domain: obs.domain ?? null,
      source: obs.source,
      outcome: obs.outcome,
      responseCode: obs.responseCode ?? null,
      responseMessage: obs.responseMessage ?? null,
      smtpValid: obs.smtpValid ?? null,
      mailboxExists: obs.mailboxExists ?? null,
      catchAll: obs.catchAll ?? null,
      provider: obs.provider ?? null,
      verificationId: obs.verificationId ?? null,
      requestId: obs.requestId ?? null,
      metadata: obs.metadata ?? null,
      rawEvidence: obs.rawEvidence ?? null,
      emailIntelExternalId: obs.externalId ?? null,
    },
    source: `email_intelligence:${obs.source}`,
    observedAt,
    confidence,
    method: "email_intel_ledger_merge",
    authority: "email_intelligence_tool",
    validation: outcome === "SUCCESS" || outcome === "FAILURE" ? "provider_verified" : undefined,
    freshnessExpiresAt: new Date(observedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
    permittedPurpose: "deliverability",
  };
}
