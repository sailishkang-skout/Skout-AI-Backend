import { createHash } from "node:crypto";

/**
 * Normalize company domain per production blueprint §3.2.
 * Accepts full URLs ("https://www.Example.com/about?x=1") and bare hosts,
 * always returning a lowercase registrable host ("example.com"). Strips
 * protocol, "www.", any path/query/fragment, port, and leading/trailing dots.
 */
export function normalizeDomain(domain: string): string {
  let value = (domain ?? "").trim().toLowerCase();
  if (!value) return "";
  // Strip scheme.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // Strip everything from the first path/query/fragment separator.
  value = value.replace(/[/?#].*$/, "");
  // Strip userinfo and port.
  value = value.replace(/^[^@]*@/, "").replace(/:\d+$/, "");
  // Strip "www." and stray leading/trailing dots.
  value = value.replace(/^www\./, "").replace(/^\.+/, "").replace(/\.+$/, "");
  return value;
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
