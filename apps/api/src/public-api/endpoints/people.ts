import { z } from "zod";
import type { Db } from "@skout/db";
import { getProspectById as osGetById, searchProspects as osSearch, type ProspectDocument } from "@skout/opensearch";
import type { Env } from "../../config/env.js";
import { openSearchConfigFromEnv } from "../../lib/opensearch-config.js";
import { getCachedDatum, recordChargedDatum } from "../../services/api-datum-cache.service.js";
import { suppressedEmailsAmong } from "../../services/suppression.service.js";
import { vendorProspectId } from "../../services/vendor-search.service.js";
import { PublicApiError } from "../errors.js";
import type { PublicIdCodec } from "../ids.js";
import type { EndpointContext, PublicEndpoint } from "../pipeline.js";
import { companyPublicId } from "./companies.js";

/**
 * GET /people/{id} and POST /people/match (PAPI-052, public API PRD §7.3, §8).
 *
 * A person's profile from Skout's index: name, title, company, location and LinkedIn URL. Never an
 * email or phone (those are /contacts/*), never a vendor name. Priced people.lookup, charged only
 * when a person is found; the same person again within 30 days is free for the workspace (CRED-4),
 * whichever of the two endpoints asks. A person whose email the workspace suppressed is not found.
 */
export interface PersonProfile {
  id: string;
  full_name: string;
  title: string | null;
  seniority: string | null;
  department: string | null;
  headline: string | null;
  company: { id: string; name: string | null; domain: string | null; industry: string | null; employee_count: number | null };
  location: { country: string | null; state: string | null; city: string | null };
  linkedin_url: string | null;
}

const blank = (v: string | undefined | null) => (v && v.trim() ? v.trim() : null);

export function toPersonProfile(doc: ProspectDocument, ids: PublicIdCodec): PersonProfile {
  return {
    id: ids.encode("person", doc.prospectId),
    full_name: doc.fullName ?? "",
    title: blank(doc.title),
    seniority: blank(doc.seniority),
    department: blank(doc.department),
    headline: blank((doc as { headline?: string }).headline),
    company: {
      id: companyPublicId(ids, doc.companyDomain, doc.companyId),
      name: blank(doc.companyName),
      domain: blank(doc.companyDomain),
      industry: blank(doc.industry),
      employee_count: doc.employeeCount ?? null,
    },
    location: { country: blank(doc.country), state: blank(doc.state), city: blank(doc.city) },
    linkedin_url: blank(doc.linkedinUrl),
  };
}

const personSubject = (prospectId: string) => `person:${prospectId}`;

/** The index document for a person, or null when absent or suppressed for this workspace. */
export async function loadPerson(deps: { env: Env; db: Db }, workspaceId: string, prospectId: string): Promise<ProspectDocument | null> {
  const cfg = openSearchConfigFromEnv(deps.env);
  if (!cfg) throw new PublicApiError("upstream_unavailable", "People lookup is temporarily unavailable. Nothing was charged; try again.");
  let doc: ProspectDocument | null;
  try {
    doc = await osGetById(cfg, prospectId);
  } catch {
    throw new PublicApiError("upstream_unavailable", "People lookup is temporarily unavailable. Nothing was charged; try again.");
  }
  if (!doc || !doc.fullName) return null;
  if (doc.email && (await suppressedEmailsAmong(deps.db, workspaceId, [doc.email])).size > 0) return null;
  return doc;
}

/** Shared billing for both endpoints: a 30-day repeat is free, a found person costs people.lookup. */
async function deliverPerson(
  deps: { env: Env; db: Db },
  ctx: EndpointContext<unknown>,
  prospectId: string
): Promise<{ data: PersonProfile; charge: number }> {
  const cached = await getCachedDatum<PersonProfile>(deps.db, ctx.workspaceId, personSubject(prospectId), "person");
  if (cached) return { data: cached, charge: 0 };
  const doc = await loadPerson(deps, ctx.workspaceId, prospectId);
  if (!doc) throw new PublicApiError("not_found", "No person matches.");
  const data = toPersonProfile(doc, ctx.ids);
  await recordChargedDatum(deps.db, ctx.workspaceId, personSubject(prospectId), "person", data);
  return { data, charge: ctx.prices["people.lookup"].credits };
}

const fixturePerson = (): PersonProfile => ({
  id: "per_test_ada",
  full_name: "Ada Lovelace",
  title: "Head of Engineering",
  seniority: "head",
  department: "engineering",
  headline: "Analytical engines",
  company: { id: "com_test_analytical", name: "Analytical Engines Ltd", domain: "example.com", industry: "Software", employee_count: 120 },
  location: { country: "GB", state: null, city: "London" },
  linkedin_url: null,
});

// --- GET /people/{id} ---------------------------------------------------------------

const getInput = z.object({ id: z.string().min(1).max(600) }).strict();

export function createGetPersonEndpoint(deps: { env: Env; db: Db }): PublicEndpoint<typeof getInput, PersonProfile> {
  return {
    method: "GET",
    path: "/people/:id",
    scope: "people:read",
    operation: "people.lookup",
    input: getInput,
    maxCost: (_i, prices) => prices["people.lookup"].credits,
    async handle(ctx) {
      const prospectId = ctx.ids.decode("person", ctx.input.id);
      // A malformed or foreign id is simply not found (no hint about what ids look like).
      if (!prospectId) throw new PublicApiError("not_found", "No person matches.");
      return deliverPerson(deps, ctx, prospectId);
    },
    fixture: () => fixturePerson(),
  };
}

// --- POST /people/match ---------------------------------------------------------------

const matchInput = z
  .object({
    linkedin_url: z.string().trim().max(300).optional(),
    full_name: z.string().trim().min(2).max(200).optional(),
    company_domain: z.string().trim().min(3).max(253).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.linkedin_url) !== Boolean(v.full_name || v.company_domain), {
    message: "Give either linkedin_url, or full_name with company_domain",
  })
  .refine((v) => Boolean(v.linkedin_url) || Boolean(v.full_name && v.company_domain), {
    message: "full_name and company_domain go together",
  })
  .refine((v) => !v.linkedin_url || /linkedin\.com\/in\/[^/?#]+/i.test(v.linkedin_url), {
    message: "linkedin_url must be a LinkedIn profile URL (linkedin.com/in/...)",
  });

const normalizeDomain = (d: string) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]!;

export function createMatchPersonEndpoint(deps: { env: Env; db: Db }): PublicEndpoint<typeof matchInput, PersonProfile> {
  return {
    method: "POST",
    path: "/people/match",
    scope: "people:read",
    operation: "people.lookup",
    input: matchInput,
    maxCost: (_i, prices) => prices["people.lookup"].credits,
    async handle(ctx) {
      const { linkedin_url, full_name, company_domain } = ctx.input;
      // The index keys people by LinkedIn profile, else by name and company (vendorProspectId).
      const direct = linkedin_url
        ? vendorProspectId({ vendor: "wiza", fullName: "", linkedinUrl: linkedin_url })
        : vendorProspectId({ vendor: "wiza", fullName: full_name!, companyDomain: normalizeDomain(company_domain!) });
      const cachedOrDirect = await getCachedDatum<PersonProfile>(deps.db, ctx.workspaceId, personSubject(direct), "person");
      if (cachedOrDirect) return { data: cachedOrDirect, charge: 0 };
      if (await loadPerson(deps, ctx.workspaceId, direct)) return deliverPerson(deps, ctx, direct);

      // Name + company: fall back to the index search for the closest match.
      if (!linkedin_url) {
        const cfg = openSearchConfigFromEnv(deps.env);
        if (cfg) {
          const res = await osSearch(cfg, { fullName: full_name, companyDomain: normalizeDomain(company_domain!) }, 1, 1).catch(() => null);
          const hit = res?.hits?.[0];
          if (hit && hit.fullName?.toLowerCase() === full_name!.toLowerCase()) return deliverPerson(deps, ctx, hit.prospectId);
        }
      }
      throw new PublicApiError("not_found", "No person matches.");
    },
    fixture: () => fixturePerson(),
  };
}
