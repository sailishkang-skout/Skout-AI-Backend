import type { Env } from "../../config/env.js";

/**
 * ENR-04 — which external providers background enrichment may call, and on what terms.
 *
 * This file is the configuration half of the provider decision; the prose half is
 * docs/enrichment-provider-policy.md. A provider is only called when BOTH hold:
 *   1. its `legalStatus` below is "approved" (a code change, reviewed like any other), and
 *   2. the deployment lists it in ENRICHMENT_PERMITTED_PROVIDERS.
 * Until Legal has signed a provider off it stays "pending_legal_review" and every job that
 * needs it ends as ACTION_REQUIRED / PROVIDER_NOT_PERMITTED instead of making a request.
 */

export type ProviderLegalStatus = "approved" | "pending_legal_review" | "prohibited";

export interface ProviderPolicy {
  id: string;
  name: string;
  /** What the provider is used for in this integration. */
  purpose: string;
  legalStatus: ProviderLegalStatus;
  /** What the provider returns and where its schema is pinned. */
  responseSchema: string;
  /** How a returned value is attributed. */
  provenance: string;
  /** Whether the provider states a verification status for contact data. */
  suppliesVerificationStatus: boolean;
  consentBasis: string;
  /** Days a raw provider response is kept before it is removed. */
  rawResponseRetentionDays: number;
  /** How a data-subject or workspace deletion reaches data from this provider. */
  deletion: string;
  /** Open items Legal has to close before `legalStatus` may become "approved". */
  openQuestions: string[];
}

export const PROVIDER_POLICIES = {
  unipile: {
    id: "unipile",
    name: "Unipile",
    purpose: "Retrieve a LinkedIn person or company profile through a workspace-connected LinkedIn account.",
    legalStatus: "pending_legal_review",
    responseSchema: "Unipile API v2 user profile / company profile; field map in unipile-profile.adapter.ts",
    provenance: "provider=unipile, the connected account id, the requested LinkedIn URL and the retrieval time",
    suppliesVerificationStatus: false,
    consentBasis: "legitimate_interest",
    rawResponseRetentionDays: 90,
    deletion: "Deleting a person or company deletes its jobs, attempts and raw responses; expired raw responses are removed daily.",
    openQuestions: [
      "LinkedIn User Agreement position on retrieving profiles through a member's connected account",
      "Unipile DPA, sub-processor list and data residency",
      "Whether contact details returned from a profile's contact section may be stored at all",
    ],
  },
} as const satisfies Record<string, ProviderPolicy>;

export type EnrichmentProviderId = keyof typeof PROVIDER_POLICIES;

export function isEnrichmentProviderId(value: string): value is EnrichmentProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDER_POLICIES, value);
}

function deploymentAllowList(config: Pick<Env, "ENRICHMENT_PERMITTED_PROVIDERS">): Set<string> {
  return new Set(
    (config.ENRICHMENT_PERMITTED_PROVIDERS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

export interface ProviderPermission {
  permitted: boolean;
  /** Why not, in words an administrator can act on. */
  reason: string | null;
}

export function providerPermission(
  config: Pick<Env, "ENRICHMENT_PERMITTED_PROVIDERS">,
  provider: EnrichmentProviderId
): ProviderPermission {
  const policy: ProviderPolicy = PROVIDER_POLICIES[provider];
  if (policy.legalStatus === "prohibited") {
    return { permitted: false, reason: `${policy.name} is not permitted for enrichment.` };
  }
  if (policy.legalStatus !== "approved") {
    return { permitted: false, reason: `${policy.name} is awaiting legal approval and cannot be used for enrichment yet.` };
  }
  if (!deploymentAllowList(config).has(provider)) {
    return { permitted: false, reason: `${policy.name} is not enabled for this environment.` };
  }
  return { permitted: true, reason: null };
}

export function listProviderPolicies(config: Pick<Env, "ENRICHMENT_PERMITTED_PROVIDERS">) {
  return (Object.keys(PROVIDER_POLICIES) as EnrichmentProviderId[]).map((id) => {
    const policy: ProviderPolicy = PROVIDER_POLICIES[id];
    const permission = providerPermission(config, id);
    return {
      id: policy.id,
      name: policy.name,
      purpose: policy.purpose,
      legalStatus: policy.legalStatus,
      permitted: permission.permitted,
      reason: permission.reason,
      suppliesVerificationStatus: policy.suppliesVerificationStatus,
      rawResponseRetentionDays: policy.rawResponseRetentionDays,
    };
  });
}
