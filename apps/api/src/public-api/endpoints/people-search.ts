import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "@skout/db";
import { seniorityEnum, type SearchProspectsRequest } from "@skout/shared";
import type { Env } from "../../config/env.js";
import { HttpError } from "../../utils/http.js";
import { SearchService } from "../../services/search.service.js";
import { getCachedDatum, recordChargedDatum } from "../../services/api-datum-cache.service.js";
import { PublicApiError } from "../errors.js";
import type { PublicIdCodec } from "../ids.js";
import type { PublicEndpoint } from "../pipeline.js";
import { companyPublicId } from "./companies.js";

/**
 * POST /people/search (PAPI-051, public API PRD §7.3, §8.1, D6).
 *
 * Index first, topped up from vendors when the index can't fill the page (SearchService). Priced by
 * where the results came from: search.index_page for a page with results, plus search.vendor_result
 * for each person a vendor returned in this request. An empty page is free; the same search page
 * repeated by the same workspace within 24 hours is free. Cursor pagination, max 25 per page.
 * Results say only skout_index or external, never which vendor.
 */
export const SEARCH_PAGE_CACHE_MS = 24 * 60 * 60_000;
const MAX_LIMIT = 25;

const text = (max: number) => z.string().trim().min(1).max(max);
export const peopleSearchInput = z
  .object({
    job_title: text(120).optional(),
    seniority: seniorityEnum.optional(),
    department: text(80).optional(),
    company_name: text(200).optional(),
    company_domain: text(253).optional(),
    industry: text(120).optional(),
    keyword: text(120).optional(),
    country: text(80).optional(),
    state: text(80).optional(),
    city: text(80).optional(),
    min_employees: z.number().int().min(0).max(10_000_000).optional(),
    max_employees: z.number().int().min(0).max(10_000_000).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(MAX_LIMIT),
    cursor: z.string().max(600).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => !["limit", "cursor"].includes(k)), {
    message: "Give at least one search filter",
  });
export type PeopleSearchInput = z.infer<typeof peopleSearchInput>;

export interface PublicPerson {
  id: string;
  full_name: string;
  title: string | null;
  seniority: string | null;
  company: { id: string; name: string | null; domain: string | null; industry: string | null; employee_count: number | null };
  location: { country: string | null; city: string | null };
  linkedin_url: string | null;
  /** Provider-neutral origin (PRD §8.1): never the vendor's name. */
  data_origin: "skout_index" | "external";
}

export interface PeopleSearchPage {
  people: PublicPerson[];
  has_more: boolean;
  next_cursor: string | null;
}

function filtersOf(input: PeopleSearchInput) {
  const { limit: _l, cursor: _c, ...filters } = input;
  return filters;
}

/** A short hash of the filters and page size, so a cursor only works for the search that made it. */
function searchHash(input: PeopleSearchInput): string {
  const f = filtersOf(input);
  const canonical = JSON.stringify(Object.keys(f).sort().map((k) => [k, (f as Record<string, unknown>)[k]]));
  return createHash("sha256").update(`${canonical}|${input.limit}`).digest("hex").slice(0, 24);
}

function pageFromCursor(ids: PublicIdCodec, input: PeopleSearchInput): number {
  if (!input.cursor) return 1;
  const raw = ids.decode("cursor", input.cursor);
  const m = raw ? /^people_search:([0-9a-f]{24}):(\d{1,5})$/.exec(raw) : null;
  if (!m || m[1] !== searchHash(input)) {
    throw new PublicApiError("invalid_request", "This cursor doesn't belong to this search. Repeat the same filters and limit, or drop the cursor.");
  }
  return Number(m[2]);
}

function toRequest(input: PeopleSearchInput, page: number): SearchProspectsRequest {
  return {
    page,
    pageSize: input.limit,
    filters: {
      jobTitle: input.job_title,
      seniority: input.seniority,
      department: input.department,
      companyName: input.company_name,
      companyDomain: input.company_domain,
      industry: input.industry,
      keyword: input.keyword,
      country: input.country,
      state: input.state,
      city: input.city,
      minEmployees: input.min_employees,
      maxEmployees: input.max_employees,
    },
  } as SearchProspectsRequest;
}

const blank = (v: string | undefined | null) => (v && v.trim() ? v : null);

export function createPeopleSearchEndpoint(deps: { env: Env; db: Db }): PublicEndpoint<typeof peopleSearchInput, PeopleSearchPage> {
  return {
    method: "POST",
    path: "/people/search",
    scope: "search:read",
    operation: "search.index_page",
    priceOperations: ["search.index_page", "search.vendor_result"],
    input: peopleSearchInput,
    // Reserve the most a page can cost: the page price plus every result coming from a vendor.
    maxCost: (input, prices) => prices["search.index_page"].credits + input.limit * prices["search.vendor_result"].credits,
    // RL-6: every result counts toward the key's daily search-result quota.
    quota: { kind: "search_results", units: (input) => input.limit },

    async handle({ input, workspaceId, apiKeyId, requestId, prices, ids }) {
      const page = pageFromCursor(ids, input);
      const subject = `search:${searchHash(input)}:${page}`;

      // A repeat of the same page within 24 hours: served from the cache, free (PRD §8.1).
      const cached = await getCachedDatum<PeopleSearchPage>(deps.db, workspaceId, subject, "search_page", new Date(), SEARCH_PAGE_CACHE_MS);
      if (cached) return { data: cached, charge: 0, quotaUsed: cached.people.length };

      let res;
      try {
        res = await new SearchService(deps.env, deps.db).searchProspects(toRequest(input, page), {
          workspaceId,
          apiKeyId,
          requestId,
          excludeSuppressed: true,
        });
      } catch (err) {
        if (err instanceof HttpError && err.statusCode >= 500) {
          throw new PublicApiError("upstream_unavailable", "People search is temporarily unavailable. Nothing was charged; try again.");
        }
        throw err;
      }

      const people: PublicPerson[] = res.results.map((r) => ({
        id: ids.encode("person", r.prospectId),
        full_name: r.fullName,
        title: blank(r.title),
        seniority: blank(r.seniority),
        company: {
          id: companyPublicId(ids, r.companyDomain, r.companyId),
          name: blank(r.companyName),
          domain: blank(r.companyDomain),
          industry: blank(r.industry),
          employee_count: r.employeeCount ?? null,
        },
        location: { country: blank(r.country), city: blank(r.city) },
        linkedin_url: blank(r.linkedinUrl),
        data_origin: r.resultSource === "vendor" ? "external" : "skout_index",
      }));
      const hasMore = people.length === input.limit && page * input.limit < res.total;
      const data: PeopleSearchPage = {
        people,
        has_more: hasMore,
        next_cursor: hasMore ? ids.encode("cursor", `people_search:${searchHash(input)}:${page + 1}`) : null,
      };

      // D6: page price when anything came back, plus each vendor-bought result.
      const vendorResults = people.filter((p) => p.data_origin === "external").length;
      const charge = people.length === 0 ? 0 : prices["search.index_page"].credits + vendorResults * prices["search.vendor_result"].credits;
      if (people.length > 0) await recordChargedDatum(deps.db, workspaceId, subject, "search_page", data);
      return { data, charge, quotaUsed: people.length };
    },

    fixture: (input) => ({
      people: [
        {
          id: "per_test_ada",
          full_name: "Ada Lovelace",
          title: input.job_title ?? "Head of Engineering",
          seniority: "head",
          company: { id: "com_test_analytical", name: "Analytical Engines Ltd", domain: "example.com", industry: "Software", employee_count: 120 },
          location: { country: "GB", city: "London" },
          linkedin_url: null,
          data_origin: "skout_index",
        },
      ],
      has_more: false,
      next_cursor: null,
    }),
  };
}
