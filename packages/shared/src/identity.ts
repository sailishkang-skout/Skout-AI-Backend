import { createHash } from "node:crypto";

/** Normalize company domain per production blueprint §3.2 */
export function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\/$/, "");
}

/** Hash email for identity — never store raw in search index if compliance-sensitive */
export function hashEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Deterministic prospect_id — stable across reindexes.
 * prospect_id = hash(normalized_company_domain + email_hash)
 */
export function generateProspectId(companyDomain: string, email: string): string {
  const domain = normalizeDomain(companyDomain);
  const emailHash = hashEmail(email);
  return createHash("sha256").update(`${domain}:${emailHash}`).digest("hex");
}

/** company_id = hash(normalized_company_domain) */
export function generateCompanyId(companyDomain: string): string {
  const domain = normalizeDomain(companyDomain);
  return createHash("sha256").update(domain).digest("hex");
}
