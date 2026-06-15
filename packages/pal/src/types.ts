/** Fields the engine can enrich, in waterfall order. */
export type EnrichField = "company" | "email" | "validation" | "phone";

export interface EnrichmentInput {
  prospectId: string;
  companyDomain: string;
  companyName?: string;
  fullName?: string;
  title?: string;
  /** Existing email, if any — skips finding, still validated. */
  email?: string;
  linkedinUrl?: string;
  /** AI lead score (0–100). Phone enrichment is gated on this (> 80). */
  leadScore?: number;
  /** Re-score after firmographics, right before the phone gate. */
  resolveLeadScoreForPhone?: (company?: CompanyData) => Promise<number>;
  /** Which fields to enrich. Defaults to company + email + validation. */
  fields?: EnrichField[];
}

export interface FieldResult {
  field: string;
  value?: string;
  valueJson?: unknown;
  provider: string;
  confidence?: number;
  validationStatus?: string;
  isPrimary?: boolean;
}

export type AttemptStatus = "ok" | "miss" | "error" | "skipped";

export interface AttemptLog {
  order: number;
  provider: string;
  operation: string;
  status: AttemptStatus;
  latencyMs: number;
  detail?: string;
}

export interface EnrichmentOutcome {
  prospectId: string;
  results: FieldResult[];
  attempts: AttemptLog[];
  /** Billable outcomes (one per successful paid step). */
  creditsUsed: number;
}

// --- Company firmographics --------------------------------------------------

export interface CompanyData {
  companyName?: string;
  industry?: string;
  employeeCount?: number;
  annualRevenue?: number;
  hqCountry?: string;
  hqCity?: string;
  foundedDate?: string;
}

export interface FirmographicsProvider {
  readonly name: string;
  fetchCompany(domain: string, name?: string): Promise<CompanyData | null>;
}

// --- Email finding ----------------------------------------------------------

export interface FoundEmail {
  email: string;
  confidence: number;
}

export interface EmailFinder {
  readonly name: string;
  findEmail(fullName: string, domain: string): Promise<FoundEmail | null>;
}

// --- Email verification -----------------------------------------------------

export type EmailVerdict = "valid" | "invalid" | "catch_all" | "risky" | "unknown";

export interface EmailVerification {
  status: EmailVerdict;
  deliverabilityScore: number; // 0–100
  catchAll: boolean;
  risky: boolean;
}

export interface EmailVerifier {
  readonly name: string;
  verify(email: string): Promise<EmailVerification>;
}

// --- Phone ------------------------------------------------------------------

export interface PhoneData {
  mobile?: string;
  direct?: string;
  hq?: string;
  /** ContactOut free-tier sample payload — not verified live data. */
  sampleData?: boolean;
  sampleMessage?: string;
}

export interface PhoneProvider {
  readonly name: string;
  fetchPhone(
    fullName: string,
    domain: string,
    linkedinUrl?: string,
    email?: string
  ): Promise<PhoneData | null>;
}

export interface ProviderRegistry {
  firmographics: FirmographicsProvider[];
  emailFinders: EmailFinder[];
  emailVerifiers: EmailVerifier[];
  phone: PhoneProvider[];
}

/** Phone enrichment only runs when lead score exceeds this. */
export const PHONE_SCORE_GATE = 80;
