import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { normalizeDomain } from "@skout/shared";
import { searchProspects as osSearch, type ProspectDocument } from "@skout/opensearch";
import type { Env } from "../../config/env.js";
import { openSearchConfigFromEnv } from "../../lib/opensearch-config.js";
import { getCachedDatum, recordChargedDatum } from "../../services/api-datum-cache.service.js";
import { getCompany as getResearchCompany } from "../../services/enrichment/research.service.js";
import { PublicApiError } from "../errors.js";
import type { PublicIdCodec } from "../ids.js";
import type { EndpointContext, PublicEndpoint } from "../pipeline.js";

/**
 * POST /companies/match and GET /companies/{id} (PAPI-053, public API PRD §7.3, §8).
 *
 * Firmographics from Skout's index (the company fields carried by the people indexed at that domain),
 * plus what the workspace itself captured about the company (LinkedIn page: headquarters, size,
 * LinkedIn URL) when it has. Priced companies.lookup, charged only when a company is found; the same
 * company again within 30 days is free for the workspace (CRED-4).
 *
 * Public company ids carry the domain ("domain:acme.com"), so every endpoint gives a company the same
 * com_ id; a company the workspace captured without a domain gets "ws:<id>", usable only there.
 */
export interface CompanyProfile {
  id: string;
  name: string | null;
  domain: string | null;
  industry: string | null;
  sub_industry: string | null;
  employee_count: number | null;
  employee_range: string | null;
  stage: string | null;
  annual_revenue: number | null;
  founded_year: number | null;
  funding: { last_round: string | null; last_round_date: string | null; total: number | null };
  currently_hiring: boolean | null;
  headcount_growth: number | null;
  tech_stack: { category: string; technology: string }[];
  headquarters: { country: string | null; location: string | null };
  linkedin_url: string | null;
}

export function companyPublicId(ids: PublicIdCodec, domain: string | null | undefined, fallbackInternalId?: string | null): string {
  const d = domain ? normalizeDomain(domain) : "";
  return d ? ids.encode("company", `domain:${d}`) : ids.encode("company", `ws:${fallbackInternalId ?? "unknown"}`);
}

const blank = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Merges the company fields of every indexed person at the domain (first value per field wins). */
async function indexCompany(env: Env, domain: string): Promise<Partial<ProspectDocument> | null> {
  const cfg = openSearchConfigFromEnv(env);
  if (!cfg) throw new PublicApiError("upstream_unavailable", "Company lookup is temporarily unavailable. Nothing was charged; try again.");
  let hits: ProspectDocument[];
  try {
    hits = (await osSearch(cfg, { companyDomain: domain }, 1, 10)).hits;
  } catch {
    throw new PublicApiError("upstream_unavailable", "Company lookup is temporarily unavailable. Nothing was charged; try again.");
  }
  const same = hits.filter((h) => normalizeDomain(h.companyDomain ?? "") === domain);
  if (same.length === 0) return null;
  const merged: Record<string, unknown> = {};
  const fields = [
    "companyName",
    "companyDomain",
    "industry",
    "subIndustry",
    "employeeCount",
    "employeeBucket",
    "companyStage",
    "annualRevenue",
    "foundedYear",
    "lastFundingRound",
    "lastFundingDate",
    "totalFunding",
    "currentlyHiring",
    "headcountGrowth",
    "techStack",
  ] as const;
  for (const h of same) {
    const row = h as unknown as Record<string, unknown>;
    for (const f of fields) if (merged[f] == null && row[f] != null) merged[f] = row[f];
  }
  return merged as Partial<ProspectDocument>;
}

type ResearchCompany = NonNullable<Awaited<ReturnType<typeof getResearchCompany>>>;

function toProfile(ids: PublicIdCodec, domain: string | null, idx: Partial<ProspectDocument> | null, research: ResearchCompany | null): CompanyProfile {
  const cap = research?.capture;
  return {
    id: companyPublicId(ids, domain, research?.id),
    name: blank(idx?.companyName) ?? blank(research?.name),
    domain: domain ?? blank(research?.domain),
    industry: blank(idx?.industry) ?? blank(research?.industry),
    sub_industry: blank(idx?.subIndustry),
    employee_count: num(idx?.employeeCount) ?? num(research?.employeeCount),
    employee_range: blank(idx?.employeeBucket) ?? blank(cap?.size),
    stage: blank(idx?.companyStage),
    annual_revenue: num(idx?.annualRevenue),
    founded_year: num(idx?.foundedYear) ?? (blank(cap?.foundedAt) && /^\d{4}$/.test(cap!.foundedAt!) ? Number(cap!.foundedAt) : null),
    funding: { last_round: blank(idx?.lastFundingRound), last_round_date: blank(idx?.lastFundingDate), total: num(idx?.totalFunding) },
    currently_hiring: typeof idx?.currentlyHiring === "boolean" ? idx.currentlyHiring : null,
    headcount_growth: num(idx?.headcountGrowth),
    tech_stack: Array.isArray(idx?.techStack) ? idx!.techStack!.slice(0, 50).map((t) => ({ category: t.category, technology: t.technology })) : [],
    headquarters: { country: blank(cap?.country), location: blank(cap?.headquarter) },
    linkedin_url: blank(research?.linkedinUrl),
  };
}

/** The workspace's own captured company for a LinkedIn company slug. */
async function researchByLinkedIn(db: Db, workspaceId: string, slug: string): Promise<ResearchCompany | null> {
  const { enrichmentIdentities } = schema;
  const [row] = await db
    .select({ entityId: enrichmentIdentities.entityId })
    .from(enrichmentIdentities)
    .where(
      and(
        eq(enrichmentIdentities.workspaceId, workspaceId),
        eq(enrichmentIdentities.entityType, "company"),
        eq(enrichmentIdentities.canonicalKey, `company:${slug.toLowerCase()}`)
      )
    )
    .limit(1);
  return row ? getResearchCompany(db, workspaceId, row.entityId) : null;
}

/** Resolves and bills one company: 30-day repeat free, found = companies.lookup, else not_found. */
async function deliverCompany(
  deps: { env: Env; db: Db },
  ctx: EndpointContext<unknown>,
  target: { domain: string | null; research: ResearchCompany | null }
): Promise<{ data: CompanyProfile; charge: number }> {
  const subject = target.domain ? `company:${target.domain}` : `company:ws:${target.research?.id}`;
  const cached = await getCachedDatum<CompanyProfile>(deps.db, ctx.workspaceId, subject, "company");
  if (cached) return { data: cached, charge: 0 };
  const idx = target.domain ? await indexCompany(deps.env, target.domain) : null;
  if (!idx && !target.research) throw new PublicApiError("not_found", "No company matches.");
  const data = toProfile(ctx.ids, target.domain, idx, target.research);
  await recordChargedDatum(deps.db, ctx.workspaceId, subject, "company", data);
  return { data, charge: ctx.prices["companies.lookup"].credits };
}

const fixtureCompany = (): CompanyProfile => ({
  id: "com_test_analytical",
  name: "Analytical Engines Ltd",
  domain: "example.com",
  industry: "Software",
  sub_industry: null,
  employee_count: 120,
  employee_range: "51-200",
  stage: "series_a",
  annual_revenue: null,
  founded_year: 1837,
  funding: { last_round: "Series A", last_round_date: null, total: null },
  currently_hiring: true,
  headcount_growth: null,
  tech_stack: [],
  headquarters: { country: "GB", location: "London" },
  linkedin_url: null,
});

// --- POST /companies/match ---------------------------------------------------------

const matchInput = z
  .object({
    domain: z.string().trim().min(3).max(253).optional(),
    linkedin_url: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.domain) !== Boolean(v.linkedin_url), { message: "Give either domain or linkedin_url" })
  .refine((v) => !v.linkedin_url || /linkedin\.com\/company\/[^/?#]+/i.test(v.linkedin_url), {
    message: "linkedin_url must be a LinkedIn company page (linkedin.com/company/...)",
  })
  .refine((v) => !v.domain || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalizeDomain(v.domain)), { message: "domain must look like example.com" });

export function createMatchCompanyEndpoint(deps: { env: Env; db: Db }): PublicEndpoint<typeof matchInput, CompanyProfile> {
  return {
    method: "POST",
    path: "/companies/match",
    scope: "companies:read",
    operation: "companies.lookup",
    input: matchInput,
    maxCost: (_i, prices) => prices["companies.lookup"].credits,
    async handle(ctx) {
      if (ctx.input.domain) {
        const domain = normalizeDomain(ctx.input.domain);
        return deliverCompany(deps, ctx, { domain, research: null });
      }
      const slug = /linkedin\.com\/company\/([^/?#]+)/i.exec(ctx.input.linkedin_url!)![1]!;
      const research = await researchByLinkedIn(deps.db, ctx.workspaceId, slug);
      if (!research) throw new PublicApiError("not_found", "No company matches.");
      const domain = research.domain ? normalizeDomain(research.domain) || null : null;
      return deliverCompany(deps, ctx, { domain, research });
    },
    fixture: () => fixtureCompany(),
  };
}

// --- GET /companies/{id} -----------------------------------------------------------

const getInput = z.object({ id: z.string().min(1).max(600) }).strict();

export function createGetCompanyEndpoint(deps: { env: Env; db: Db }): PublicEndpoint<typeof getInput, CompanyProfile> {
  return {
    method: "GET",
    path: "/companies/:id",
    scope: "companies:read",
    operation: "companies.lookup",
    input: getInput,
    maxCost: (_i, prices) => prices["companies.lookup"].credits,
    async handle(ctx) {
      const internal = ctx.ids.decode("company", ctx.input.id);
      if (internal?.startsWith("domain:")) return deliverCompany(deps, ctx, { domain: internal.slice(7), research: null });
      if (internal?.startsWith("ws:")) {
        // Only the workspace that captured it can open it (the lookup is scoped to the workspace).
        const research = await getResearchCompany(deps.db, ctx.workspaceId, internal.slice(3)).catch(() => null);
        if (research) return deliverCompany(deps, ctx, { domain: research.domain ? normalizeDomain(research.domain) || null : null, research });
      }
      throw new PublicApiError("not_found", "No company matches.");
    },
    fixture: () => fixtureCompany(),
  };
}
