/** Verified-only rule: work emails are persisted only after validation passes. */

import type { ProspectSnapshot } from "../services/enrichment/service.js";

export function isVerifiedEmailStatus(status: unknown): boolean {
  return status === "valid";
}

export function stripUnverifiedEmail<T extends Record<string, unknown>>(snapshot: T): T {
  if (!snapshot.email) return snapshot;
  if (isVerifiedEmailStatus(snapshot.emailStatus)) return snapshot;
  const { email: _removed, ...rest } = snapshot;
  return rest as T;
}

/** OpenSearch corpus rows may include emails — never treat as verified activations. */
export function snapshotFromCorpusDoc(
  doc: {
    prospectId: string;
    companyId: string;
    fullName?: string;
    title?: string;
    seniority?: string;
    industry?: string;
    country?: string;
    companyDomain: string;
    companyName?: string;
    employeeCount?: number;
    linkedinUrl?: string;
    /** Present on corpus docs but intentionally omitted from activation snapshots. */
    email?: string;
  }
): ProspectSnapshot {
  return {
    prospectId: doc.prospectId,
    companyId: doc.companyId,
    fullName: doc.fullName,
    title: doc.title,
    seniority: doc.seniority,
    industry: doc.industry,
    country: doc.country,
    companyDomain: doc.companyDomain,
    companyName: doc.companyName,
    employeeCount: doc.employeeCount,
    linkedinUrl: doc.linkedinUrl,
  };
}
