import { z } from "zod";
import {
  companyIdFromCompanyUrl,
  isSalesNavigatorUrl,
  normalizeLinkedinId,
  publicIdFromProfileUrl,
  salesLeadIdFromUrl,
} from "./capture-identity.js";

/**
 * ENR-02 — ingest payload contracts for the extension's reviewed captures (person, company,
 * Sales Navigator search). Ported from the EnrichmentTool prototype's `lib/schemas.ts` and
 * tightened: bounded sizes, LinkedIn-only source URLs, and no identity that the URL does not
 * itself show.
 */

/** Workload controls, not a LinkedIn safety guarantee. Enforced server-side per capture run. */
export const CAPTURE_CAPS = {
  MAX_PAGES_PER_RUN: 10,
  MAX_LEADS_PER_RUN: 250,
  DEFAULT_DAILY_LEADS_PER_USER: 1000,
} as const;

/** Request body ceiling for ingest routes (bytes). */
export const CAPTURE_BODY_LIMIT_BYTES = 1_048_576;

const MAX_FACT_ITEM_BYTES = 8_000;

const text = (max: number) => z.string().trim().max(max);
const name = text(300);
const count = z.number().int().nonnegative().max(2_000_000_000);

const factItem = z
  .record(z.unknown())
  .refine((value) => JSON.stringify(value).length <= MAX_FACT_ITEM_BYTES, "Captured item is too large");
const factList = (max = 100) => z.array(factItem).max(max);

const linkedinUrl = z
  .string()
  .url()
  .max(2_000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && ["www.linkedin.com", "linkedin.com"].includes(url.hostname);
    } catch {
      return false;
    }
  }, "Expected a LinkedIn URL");

const publicProfileUrl = linkedinUrl.refine(
  (value) => !!publicIdFromProfileUrl(value),
  "Expected a public LinkedIn /in/ profile URL"
);
const companyUrl = linkedinUrl.refine((value) => !!companyIdFromCompanyUrl(value), "Expected a LinkedIn company URL");
const salesUrl = linkedinUrl.refine(isSalesNavigatorUrl, "Expected a Sales Navigator URL");

const linkedinId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\s/?#]+$/, "Not a LinkedIn identifier");

const runId = z.string().uuid().optional();

const relationshipContext = z
  .object({
    degree: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    isDirectConnection: z.boolean().optional(),
    mutualConnections: z
      .array(z.object({ name: name.optional(), profileUrl: linkedinUrl.optional() }))
      .max(50)
      .optional(),
    mutualConnectionsText: text(1_000).optional(),
    sharedCompanyText: text(1_000).optional(),
    salesNavigatorLeadUrl: salesUrl.optional(),
    activitySignals: z.array(text(100)).max(10).optional(),
  })
  .strict();

export const personIngestSchema = z
  .object({
    runId,
    publicId: linkedinId,
    sourceUrl: publicProfileUrl,
    capturedAt: z.string().datetime().optional(),

    fullName: name.min(1),
    firstName: name.optional(),
    lastName: name.optional(),
    headline: text(500).optional(),
    summary: text(20_000).optional(),
    industry: name.optional(),
    locationName: name.optional(),
    locationCountry: name.optional(),
    logoUrl: z.string().url().max(2_000).optional(),
    connectionsCount: count.optional(),
    followersCount: count.optional(),
    relationshipContext: relationshipContext.optional(),
    currentCompanies: factList(50).optional(),
    previousCompanies: factList().optional(),
    educations: factList(50).optional(),
    volunteerExperiences: factList(50).optional(),
    skills: z.array(z.union([name, factItem])).max(300).optional(),
    pronoun: text(100).optional(),
    languages: factList(50).optional(),
    recommendations: factList(50).optional(),
    certifications: factList().optional(),
    courses: factList().optional(),
    honors: factList().optional(),
    organizations: factList().optional(),
    patents: factList().optional(),
    projects: factList().optional(),
    publications: factList().optional(),
    jobFunction: name.optional(),
    seniority: name.optional(),
    openToWork: z.boolean().optional(),
    hiring: z.boolean().optional(),
    /** LinkedIn company id/slug taken from the current role's own company link. */
    currentCompanyPublicId: linkedinId.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (publicIdFromProfileUrl(value.sourceUrl) !== normalizeLinkedinId(value.publicId)) {
      ctx.addIssue({ code: "custom", path: ["publicId"], message: "Public LinkedIn URL does not match person ID." });
    }
  });

const companySectionSchema = z
  .object({
    text: z.string().trim().min(1).max(30_000),
    sourceUrl: companyUrl,
    capturedAt: z.string().datetime(),
    method: z.enum(["reviewed-text", "rendered-dom"]),
    scope: z.literal("loaded-page").optional(),
  })
  .strict();

export const COMPANY_SECTION_KEYS = [
  "home",
  "about",
  "overview",
  "posts",
  "products",
  "jobs",
  "life",
  "people",
  "salesInsights",
  "pastEvents",
  "peopleHighlights",
  "exclusiveInsights",
  "newsletters",
] as const;

const discoveryProfile = z
  .object({
    publicId: linkedinId,
    sourceUrl: publicProfileUrl,
    fullName: name.optional(),
    headline: text(500).optional(),
    associationSource: z.enum(["company-people-page", "company-search-result"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (publicIdFromProfileUrl(value.sourceUrl) !== normalizeLinkedinId(value.publicId)) {
      ctx.addIssue({ code: "custom", path: ["publicId"], message: "Public LinkedIn URL does not match person ID." });
    }
  });

export const companyIngestSchema = z
  .object({
    runId,
    publicId: linkedinId,
    memberId: z.string().trim().regex(/^\d{1,20}$/).optional(),
    sourceUrl: companyUrl,
    capturedAt: z.string().datetime().optional(),
    /** Result pages read for `peopleProfiles` in this request. */
    pagesRead: z.number().int().min(0).max(CAPTURE_CAPS.MAX_PAGES_PER_RUN).optional(),
    /** Profiles visibly rendered in company people results: discovery candidates only. */
    peopleProfiles: z.array(discoveryProfile).max(CAPTURE_CAPS.MAX_LEADS_PER_RUN).optional(),

    name: name.optional(),
    website: text(2_000).optional(),
    domain: text(300).optional(),
    logoUrl: z.string().url().max(2_000).optional(),
    locationCountry: name.optional(),
    phone: text(60).optional(),
    industry: name.optional(),
    tagline: text(1_000).optional(),
    overview: text(20_000).optional(),
    revenue: name.optional(),
    size: name.optional(),
    employeesOnLi: count.optional(),
    specialties: z.array(name).max(100).optional(),
    headquarter: name.optional(),
    followers: count.optional(),
    foundedAt: text(60).optional(),
    locations: factList(50).optional(),
    hashtags: z.array(name).max(50).optional(),
    funding: factItem.optional(),
    recentPosts: factList(20).optional(),
    openJobs: factList(200).optional(),
    products: factList().optional(),
    life: z.array(z.union([text(4_000), factItem])).max(50).optional(),
    peopleStats: factItem.optional(),
    insights: factItem.optional(),
    sectionCaptures: z.record(z.enum(COMPANY_SECTION_KEYS), companySectionSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (companyIdFromCompanyUrl(value.sourceUrl) !== normalizeLinkedinId(value.publicId)) {
      ctx.addIssue({ code: "custom", path: ["publicId"], message: "Company URL does not match company ID." });
    }
  });

const salesRole = z
  .object({ name: name.optional(), title: text(500).optional(), companyPublicId: linkedinId.optional() })
  .strict();

const salesLeadProfile = z
  .object({
    /** A real public id, or `sales-lead:<opaque-id>` for a lead without a visible public link. */
    publicId: z.string().trim().min(1).max(220),
    sourceUrl: linkedinUrl,
    fullName: name.optional(),
    headline: text(500).optional(),
    locationName: name.optional(),
    currentCompanies: z.array(salesRole).max(5).optional(),
    relationshipContext: relationshipContext.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const publicUrlId = publicIdFromProfileUrl(value.sourceUrl);
    const leadUrl = value.relationshipContext?.salesNavigatorLeadUrl;
    const leadId = leadUrl ? salesLeadIdFromUrl(leadUrl) : undefined;
    if (leadUrl && !leadId) {
      ctx.addIssue({ code: "custom", path: ["relationshipContext"], message: "Not a Sales Navigator lead URL." });
    }
    if (publicUrlId) {
      if (publicUrlId !== normalizeLinkedinId(value.publicId)) {
        ctx.addIssue({ code: "custom", path: ["publicId"], message: "Public LinkedIn URL does not match person ID." });
      }
      return;
    }
    // Without a visible public link the record stays a Sales lead; an /in/ URL is never derived.
    if (!leadId || value.publicId !== `sales-lead:${leadId}` || salesLeadIdFromUrl(value.sourceUrl) !== leadId) {
      ctx.addIssue({
        code: "custom",
        path: ["publicId"],
        message: "Sales Navigator lead requires its original lead URL.",
      });
    }
  });

export const salesSearchIngestSchema = z
  .object({
    runId,
    sourceUrl: salesUrl,
    capturedAt: z.string().datetime().optional(),
    filters: z.array(text(300)).max(100).optional(),
    /** Rendered result pages read for this request. */
    pagesRead: z.number().int().min(1).max(CAPTURE_CAPS.MAX_PAGES_PER_RUN).default(1),
    resultCount: count.optional(),
    peopleProfiles: z.array(salesLeadProfile).min(1).max(CAPTURE_CAPS.MAX_LEADS_PER_RUN),
  })
  .strict();

export const startRunSchema = z
  .object({
    kind: z.enum(["person", "company", "sales_search"]),
    sourceUrl: linkedinUrl.optional(),
    clientRunId: z.string().trim().min(8).max(100).optional(),
  })
  .strict();

export const finishRunSchema = z
  .object({
    status: z.enum(["completed", "stopped", "failed"]),
    reason: text(500).optional(),
  })
  .strict();

export const captureSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    reason: text(500).optional(),
    dailyLeadLimit: z.number().int().min(0).max(100_000).optional(),
  })
  .strict()
  .refine((value) => value.enabled !== undefined || value.dailyLeadLimit !== undefined, "Nothing to update");

export type PersonIngestInput = z.infer<typeof personIngestSchema>;
export type CompanyIngestInput = z.infer<typeof companyIngestSchema>;
export type SalesSearchIngestInput = z.infer<typeof salesSearchIngestSchema>;
export type CaptureRunKind = z.infer<typeof startRunSchema>["kind"];

// ── Profile-fact hygiene ──────────────────────────────────────────────────────
// LinkedIn renders recommendation rails, ad controls and endorsement captions next to
// profile content. None of it is a fact about the person or company being captured.

const PAGE_CHROME_PHRASE =
  /\b(people you may know|people also viewed|more profiles for you|suggested for you|you might like|ad options?|why am i seeing this ad|manage your ad preferences|hide or report this ad|promoted by)\b/i;
const PAGE_CHROME_LABEL =
  /^(profile|skills?|top skills?|all activity|activity|experience|education|show all|show more|untitled role|view|message|connect|follow|save|promoted|sponsored|contact info)$/i;
const ENDORSEMENT_HELPER = /^(endorsed by\b|\d+[+,]?\s+endorsements?\b|\d+ experiences? at\b|\d+[+,]?$)/i;

export function isPageChrome(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const candidate = value.replace(/\s+/g, " ").trim();
  if (!candidate) return false;
  return PAGE_CHROME_PHRASE.test(candidate) || PAGE_CHROME_LABEL.test(candidate);
}

export function isEndorsementHelperText(value: unknown): boolean {
  return typeof value === "string" && ENDORSEMENT_HELPER.test(value.trim());
}

/** The label that identifies each kind of captured list item. */
const ITEM_LABEL_KEYS: Record<string, string[]> = {
  currentCompanies: ["title", "name"],
  previousCompanies: ["title", "name"],
  educations: ["school"],
  volunteerExperiences: ["role", "organization"],
  languages: ["language"],
  recommendations: ["recommenderName"],
  certifications: ["name"],
  courses: ["name"],
  honors: ["title"],
  organizations: ["name"],
  patents: ["title"],
  projects: ["title", "name"],
  publications: ["title"],
};

export interface SanitizedPerson {
  data: PersonIngestInput;
  /** `field` or `field[index]` entries removed because they were not profile facts. */
  rejected: string[];
}

/** Drops page chrome, ads, suggestions and endorsement captions from a person capture. */
export function sanitizePersonCapture(input: PersonIngestInput): SanitizedPerson {
  const rejected: string[] = [];
  const data: Record<string, unknown> = { ...input };

  for (const field of ["headline", "locationName", "industry", "jobFunction", "seniority"] as const) {
    if (isPageChrome(data[field])) {
      rejected.push(field);
      delete data[field];
    }
  }

  if (Array.isArray(input.skills)) {
    const kept = input.skills.filter((skill, index) => {
      const label = typeof skill === "string" ? skill : skill.name;
      const bad = typeof label !== "string" || !label.trim() || isPageChrome(label) || isEndorsementHelperText(label);
      if (bad) rejected.push(`skills[${index}]`);
      return !bad;
    });
    if (kept.length) data.skills = kept;
    else delete data.skills;
  }

  for (const [field, labelKeys] of Object.entries(ITEM_LABEL_KEYS)) {
    const items = data[field];
    if (!Array.isArray(items)) continue;
    const kept = items.filter((item, index) => {
      const labels = labelKeys.map((key) => (item as Record<string, unknown>)[key]);
      const bad = labels.some((label) => isPageChrome(label) || isEndorsementHelperText(label));
      if (bad) rejected.push(`${field}[${index}]`);
      return !bad;
    });
    if (kept.length) data[field] = kept;
    else delete data[field];
  }

  return { data: data as PersonIngestInput, rejected };
}

/** A discovery card is only usable when its name is a person's name. */
export function isUsableCardName(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && !isPageChrome(value) && !isEndorsementHelperText(value);
}
