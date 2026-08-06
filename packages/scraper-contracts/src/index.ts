import { z } from "zod";

/**
 * Shared scraping-platform contracts.
 *
 * Consumed by the orchestrator, scraper bots, cleaner, ingestor, and the PAL
 * `scraper` enrichment adapter. Field set mirrors the filter→field map in
 * docs/data-enrichment-strategy.md §3. Identity hashing stays in `@skout/shared`
 * (ADR 0001) — these schemas carry the *inputs* to that hashing, not the hashes.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const scrapeSourceEnum = z.enum([
  "company-web",
  "linkedin",
  "linkedin-jobs",
  "opencorporates",
  "sec-edgar",
  "crunchbase",
  "google-business",
  "job-board",
]);
export type ScrapeSource = z.infer<typeof scrapeSourceEnum>;

export const employeeBucketEnum = z.enum([
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1000+",
]);
export type EmployeeBucket = z.infer<typeof employeeBucketEnum>;

export const companyStageEnum = z.enum([
  "bootstrapped",
  "seed",
  "series_a",
  "series_b",
  "series_c_plus",
  "public",
  "unknown",
]);

export const seniorityEnum = z.enum([
  "founder",
  "c_suite",
  "vp",
  "director",
  "head",
  "manager",
  "individual_contributor",
  "unknown",
]);

export const techCategoryEnum = z.enum([
  "crm",
  "marketing_automation",
  "cms",
  "analytics",
  "payments",
  "cloud",
  "other",
]);

export const signalTypeEnum = z.enum([
  "recent_funding",
  "leadership_change",
  "product_launch",
  "recent_hiring",
  "market_expansion",
  "new_office",
  "acquisition",
  "website_change",
  "tech_adoption",
  "headcount_growth",
]);
export type SignalType = z.infer<typeof signalTypeEnum>;

export const jobStatusEnum = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof jobStatusEnum>;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Where a single field value came from — kept for compliance + conflict resolution. */
export const fieldProvenanceSchema = z.object({
  field: z.string(),
  source: scrapeSourceEnum.or(z.string()),
  scrapedAt: z.string().datetime(),
  confidence: z.number().min(0).max(1).optional(),
});
export type FieldProvenance = z.infer<typeof fieldProvenanceSchema>;

export const techStackEntrySchema = z.object({
  category: techCategoryEnum,
  technology: z.string(),
});
export type TechStackEntry = z.infer<typeof techStackEntrySchema>;

export const signalSchema = z.object({
  type: signalTypeEnum,
  observedAt: z.string().datetime(),
  detail: z.string().optional(),
  source: scrapeSourceEnum.or(z.string()).optional(),
});
export type Signal = z.infer<typeof signalSchema>;

export const fundingSchema = z.object({
  totalRaised: z.number().nonnegative().optional(),
  lastRound: z.string().optional(),
  lastRoundDate: z.string().optional(),
  numberOfRounds: z.number().int().nonnegative().optional(),
  investors: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Company + prospect candidates (cleaner output)
// ---------------------------------------------------------------------------

export const companyCandidateSchema = z.object({
  source: scrapeSourceEnum,
  companyName: z.string().optional(),
  domain: z.string().min(1), // required for identity (ADR 0001)
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  industry: z.string().optional(),
  subIndustry: z.string().optional(),
  hqCountry: z.string().optional(),
  hqState: z.string().optional(),
  hqCity: z.string().optional(),
  timezone: z.string().optional(),
  employeeCount: z.number().int().nonnegative().optional(),
  employeeBucket: employeeBucketEnum.optional(),
  annualRevenue: z.number().nonnegative().optional(),
  revenueRange: z.string().optional(),
  companyStage: companyStageEnum.optional(),
  funding: fundingSchema.optional(),
  techStack: z.array(techStackEntrySchema).optional(),
  isHiring: z.boolean().optional(),
  openJobs: z.number().int().nonnegative().optional(),
  hiringByDept: z.record(z.number().int().nonnegative()).optional(),
  signals: z.array(signalSchema).optional(),
  foundedDate: z.string().optional(),
  isPublic: z.boolean().optional(),
  scrapedAt: z.string().datetime(),
  rawS3Key: z.string().optional(),
  provenance: z.array(fieldProvenanceSchema).optional(),
  qualityScore: z.number().min(0).max(100).optional(),
});
export type CompanyCandidate = z.infer<typeof companyCandidateSchema>;

export const prospectCandidateSchema = z.object({
  source: scrapeSourceEnum,
  fullName: z.string().optional(),
  title: z.string().optional(),
  department: z.string().optional(),
  seniority: seniorityEnum.optional(),
  jobFunction: z.string().optional(),
  email: z.string().email().optional(),
  linkedinUrl: z.string().url().optional(),
  companyName: z.string().optional(),
  companyDomain: z.string().min(1), // required for identity
  country: z.string().optional(),
  tenureCompanyMonths: z.number().int().nonnegative().optional(),
  tenureRoleMonths: z.number().int().nonnegative().optional(),
  previousCompany: z.string().optional(),
  contactSignals: z.array(signalSchema).optional(),
  scrapedAt: z.string().datetime(),
  rawS3Key: z.string().optional(),
  provenance: z.array(fieldProvenanceSchema).optional(),
  qualityScore: z.number().min(0).max(100).optional(),
});
export type ProspectCandidate = z.infer<typeof prospectCandidateSchema>;

// ---------------------------------------------------------------------------
// Raw bot output → S3 raw zone
// ---------------------------------------------------------------------------

export const rawScrapeRecordSchema = z.object({
  jobId: z.string(),
  source: scrapeSourceEnum,
  scrapedAt: z.string().datetime(),
  url: z.string().optional(),
  payload: z.unknown(), // raw HTML / JSON API response
  meta: z.record(z.unknown()).optional(),
});
export type RawScrapeRecord = z.infer<typeof rawScrapeRecordSchema>;

// ---------------------------------------------------------------------------
// Orchestrator input
// ---------------------------------------------------------------------------

export const scrapeJobRequestSchema = z.object({
  source: scrapeSourceEnum,
  seeds: z.array(z.string()).min(1), // domains, URLs, or search queries
  options: z
    .object({
      geo: z.string().optional(),
      industry: z.string().optional(),
      maxRecords: z.number().int().positive().optional(),
      priority: z.enum(["low", "normal", "high"]).default("normal"),
    })
    .optional(),
});
export type ScrapeJobRequest = z.infer<typeof scrapeJobRequestSchema>;

export const scrapeJobResultSchema = z.object({
  jobId: z.string(),
  source: scrapeSourceEnum,
  scrapedAt: z.string().datetime(),
  rawS3Key: z.string().optional(),
  recordCount: z.number().int().nonnegative(),
});
export type ScrapeJobResult = z.infer<typeof scrapeJobResultSchema>;

// ---------------------------------------------------------------------------
// Lineage manifest: raw → clean → ingested
// ---------------------------------------------------------------------------

export const scrapeJobManifestSchema = z.object({
  jobId: z.string(),
  source: scrapeSourceEnum,
  status: jobStatusEnum,
  counts: z.object({
    raw: z.number().int().nonnegative(),
    clean: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative(),
    ingested: z.number().int().nonnegative(),
    skippedDuplicate: z.number().int().nonnegative(),
  }),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});
export type ScrapeJobManifest = z.infer<typeof scrapeJobManifestSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a raw employee count to the product's size bucket. */
export function toEmployeeBucket(count: number | undefined): EmployeeBucket | undefined {
  if (count == null) return undefined;
  if (count <= 10) return "1-10";
  if (count <= 50) return "11-50";
  if (count <= 200) return "51-200";
  if (count <= 500) return "201-500";
  if (count <= 1000) return "501-1000";
  return "1000+";
}
