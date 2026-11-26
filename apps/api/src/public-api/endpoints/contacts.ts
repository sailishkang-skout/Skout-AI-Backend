import { z } from "zod";
import type { Db } from "@skout/db";
import { normalizeDomain } from "@skout/shared";
import type { EnrichmentEngine, EnrichmentOutcome } from "@skout/pal";
import type { Env } from "../../config/env.js";
import { getCachedDatum, recordChargedDatum } from "../../services/api-datum-cache.service.js";
import { createProviderCostRecorder, providerCallsFromAttempts } from "../../services/provider-cost.service.js";
import { suppressedEmailsAmong } from "../../services/suppression.service.js";
import { resolveWorkspaceEngine } from "../../services/enrichment/index.js";
import { vendorProspectId } from "../../services/vendor-search.service.js";
import { PublicApiError } from "../errors.js";
import type { PublicEndpoint } from "../pipeline.js";
import { loadPerson } from "./people.js";

/**
 * POST /contacts/email/find (PAPI-055, public API PRD §7.3, §8, §9).
 *
 * Runs the same email waterfall as an in-app reveal (finders in order, then the verifier) and returns
 * the email only when the verifier says it is valid. Priced contacts.email_find, charged only for a
 * verified email; the same person's email again within 30 days is free (CRED-4). The response carries
 * provenance (source class, retrieval time, expiry), never the provider's name. A person or email the
 * workspace suppressed is not found.
 */
export const CONTACT_FRESHNESS_MS = 90 * 86_400_000;

export interface FoundEmail {
  person: { id: string | null; full_name: string; company_domain: string };
  email: string;
  status: "valid";
  provenance: { source_class: "external"; retrieved_at: string; expires_at: string };
}

export interface ContactsDeps {
  env: Env;
  db: Db;
  /** The provider waterfall for a workspace; tests inject a fake one. */
  resolveEngine?: (workspaceId: string) => Promise<EnrichmentEngine>;
}

const emailFindInput = z
  .object({
    person_id: z.string().min(1).max(600).optional(),
    full_name: z.string().trim().min(2).max(200).optional(),
    company_domain: z.string().trim().min(3).max(253).optional(),
    linkedin_url: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.person_id) !== Boolean(v.full_name || v.company_domain), {
    message: "Give either person_id, or full_name with company_domain",
  })
  .refine((v) => Boolean(v.person_id) || Boolean(v.full_name && v.company_domain), {
    message: "full_name and company_domain go together",
  })
  .refine((v) => !v.company_domain || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalizeDomain(v.company_domain)), {
    message: "company_domain must look like example.com",
  })
  .refine((v) => !v.linkedin_url || /linkedin\.com\/in\/[^/?#]+/i.test(v.linkedin_url), {
    message: "linkedin_url must be a LinkedIn profile URL (linkedin.com/in/...)",
  });

const unavailable = () => new PublicApiError("upstream_unavailable", "Email find is temporarily unavailable. Nothing was charged; try again.");

/** The verified email the waterfall produced, or null. Throws when every provider call failed. */
export function verifiedEmailFrom(outcome: EnrichmentOutcome): string | null {
  const status = outcome.results.find((r) => r.field === "email_status")?.value;
  const email = outcome.results.find((r) => r.field === "email" && r.isPrimary && r.value)?.value;
  if (status === "valid" && email) return email.trim().toLowerCase();
  const calls = outcome.attempts.filter((a) => a.status !== "skipped" && a.provider !== "internal_graph");
  if (calls.length > 0 && calls.every((a) => a.status === "error")) throw unavailable();
  return null;
}

export function createEmailFindEndpoint(deps: ContactsDeps): PublicEndpoint<typeof emailFindInput, FoundEmail> {
  const resolveEngine = deps.resolveEngine ?? ((ws: string) => resolveWorkspaceEngine(deps.db, deps.env, ws));
  const recordCosts = createProviderCostRecorder(deps.db, deps.env.PROVIDER_UNIT_COSTS_JSON);
  return {
    method: "POST",
    path: "/contacts/email/find",
    scope: "contacts:reveal",
    operation: "contacts.email_find",
    input: emailFindInput,
    maxCost: (_i, prices) => prices["contacts.email_find"].credits,

    async handle({ input, workspaceId, apiKeyId, requestId, prices, ids }) {
      // Who: a person from search or lookup, or a name at a company domain.
      let prospectId: string;
      let person: { fullName: string; domain: string; linkedinUrl?: string; companyName?: string; publicId: string | null };
      if (input.person_id) {
        const decoded = ids.decode("person", input.person_id);
        if (!decoded) throw new PublicApiError("not_found", "No person matches.");
        prospectId = decoded;
        const doc = await loadPerson(deps, workspaceId, prospectId);
        const domain = doc?.companyDomain ? normalizeDomain(doc.companyDomain) : "";
        if (!doc || !doc.fullName || !domain) throw new PublicApiError("not_found", "No person matches.");
        person = { fullName: doc.fullName, domain, linkedinUrl: doc.linkedinUrl ?? undefined, companyName: doc.companyName ?? undefined, publicId: input.person_id };
      } else {
        const domain = normalizeDomain(input.company_domain!);
        prospectId = vendorProspectId({ vendor: "wiza", fullName: input.full_name!, companyDomain: domain });
        person = { fullName: input.full_name!, domain, linkedinUrl: input.linkedin_url, publicId: null };
      }
      const subject = `person:${prospectId}`;

      // The same person's email within 30 days: free, unless the workspace has since suppressed it.
      const cached = await getCachedDatum<FoundEmail>(deps.db, workspaceId, subject, "email");
      if (cached) {
        if ((await suppressedEmailsAmong(deps.db, workspaceId, [cached.email])).size > 0) throw new PublicApiError("not_found", "No verified email found.");
        return { data: cached, charge: 0 };
      }

      let outcome: EnrichmentOutcome;
      try {
        const engine = await resolveEngine(workspaceId);
        outcome = await engine.enrich({
          prospectId,
          companyDomain: person.domain,
          companyName: person.companyName,
          fullName: person.fullName,
          linkedinUrl: person.linkedinUrl,
          fields: ["email", "validation"],
        });
      } catch (err) {
        // Providers not configured or the waterfall itself failed: nothing charged.
        if (err instanceof PublicApiError) throw err;
        throw unavailable();
      }
      await recordCosts(providerCallsFromAttempts(outcome.attempts), { source: "enrichment", workspaceId, apiKeyId, requestId });

      const email = verifiedEmailFrom(outcome);
      // No verified email, or one the workspace suppressed: not found, nothing charged (CRED-4, §9.6).
      if (!email || (await suppressedEmailsAmong(deps.db, workspaceId, [email])).size > 0) {
        throw new PublicApiError("not_found", "No verified email found.");
      }
      const now = new Date();
      const data: FoundEmail = {
        person: { id: person.publicId ?? ids.encode("person", prospectId), full_name: person.fullName, company_domain: person.domain },
        email,
        status: "valid",
        provenance: { source_class: "external", retrieved_at: now.toISOString(), expires_at: new Date(now.getTime() + CONTACT_FRESHNESS_MS).toISOString() },
      };
      await recordChargedDatum(deps.db, workspaceId, subject, "email", data, now);
      return { data, charge: prices["contacts.email_find"].credits };
    },

    fixture: (input) => ({
      person: { id: "per_test_ada", full_name: input.full_name ?? "Ada Lovelace", company_domain: "example.com" },
      email: "ada@example.com",
      status: "valid",
      provenance: { source_class: "external", retrieved_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-04-01T00:00:00.000Z" },
    }),
  };
}
