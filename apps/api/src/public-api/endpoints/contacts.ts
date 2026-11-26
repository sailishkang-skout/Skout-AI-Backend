import { z } from "zod";
import type { Db } from "@skout/db";
import { normalizeDomain } from "@skout/shared";
import type { EnrichmentEngine, EnrichmentInput, EnrichmentOutcome, PhoneData } from "@skout/pal";
import type { Env } from "../../config/env.js";
import { getCachedDatum, recordChargedDatum } from "../../services/api-datum-cache.service.js";
import { createProviderCostRecorder, providerCallsFromAttempts } from "../../services/provider-cost.service.js";
import { suppressedEmailsAmong } from "../../services/suppression.service.js";
import { resolveWorkspaceEngine } from "../../services/enrichment/index.js";
import { vendorProspectId } from "../../services/vendor-search.service.js";
import { PublicApiError } from "../errors.js";
import type { PublicIdCodec } from "../ids.js";
import type { PublicEndpoint } from "../pipeline.js";
import { loadPerson } from "./people.js";

/**
 * POST /contacts/email/find (PAPI-055) and POST /contacts/phone/find (PAPI-056), public API PRD
 * §7.3, §8, §9.
 *
 * Both run the same provider waterfall as an in-app reveal, through the workspace's engine (its own
 * provider keys first). Each is charged only when it finds something (an email the verifier says is
 * valid; a phone number), and the same person's datum again within 30 days is free (CRED-4). The
 * response carries provenance (source class, retrieval time, expiry), never the provider's name. A
 * person or email the workspace suppressed is not found.
 */
export const CONTACT_FRESHNESS_MS = 90 * 86_400_000;

type Provenance = { source_class: "external"; retrieved_at: string; expires_at: string };
type PersonRef = { id: string | null; full_name: string; company_domain: string };

export interface FoundEmail {
  person: PersonRef;
  email: string;
  status: "valid";
  provenance: Provenance;
}

export interface FoundPhone {
  person: PersonRef;
  phone: string;
  type: "mobile" | "direct";
  provenance: Provenance;
}

export interface ContactsDeps {
  env: Env;
  db: Db;
  /** The provider waterfall for a workspace; tests inject a fake one. */
  resolveEngine?: (workspaceId: string) => Promise<EnrichmentEngine>;
}

const contactFindInput = z
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
type ContactInput = z.infer<typeof contactFindInput>;

const unavailable = (what: string) =>
  new PublicApiError("upstream_unavailable", `${what} is temporarily unavailable. Nothing was charged; try again.`);

interface Target {
  prospectId: string;
  subject: string;
  fullName: string;
  domain: string;
  linkedinUrl?: string;
  companyName?: string;
  publicId: string;
}

/** Who the caller means: a person from search or lookup (index profile), or a name at a company domain. */
async function resolveTarget(deps: ContactsDeps, workspaceId: string, ids: PublicIdCodec, input: ContactInput): Promise<Target> {
  if (input.person_id) {
    const prospectId = ids.decode("person", input.person_id);
    if (!prospectId) throw new PublicApiError("not_found", "No person matches.");
    // loadPerson also treats a person whose email the workspace suppressed as absent.
    const doc = await loadPerson(deps, workspaceId, prospectId);
    const domain = doc?.companyDomain ? normalizeDomain(doc.companyDomain) : "";
    if (!doc || !doc.fullName || !domain) throw new PublicApiError("not_found", "No person matches.");
    return {
      prospectId,
      subject: `person:${prospectId}`,
      fullName: doc.fullName,
      domain,
      linkedinUrl: doc.linkedinUrl ?? undefined,
      companyName: doc.companyName ?? undefined,
      publicId: input.person_id,
    };
  }
  const domain = normalizeDomain(input.company_domain!);
  const prospectId = vendorProspectId({ vendor: "wiza", fullName: input.full_name!, companyDomain: domain });
  return {
    prospectId,
    subject: `person:${prospectId}`,
    fullName: input.full_name!,
    domain,
    linkedinUrl: input.linkedin_url,
    publicId: ids.encode("person", prospectId),
  };
}

/** Runs the workspace's waterfall and records every provider call's cost (PAPI-013). */
async function runWaterfall(
  deps: ContactsDeps,
  resolveEngine: (ws: string) => Promise<EnrichmentEngine>,
  ctx: { workspaceId: string; apiKeyId: string; requestId: string },
  target: Target,
  extra: Partial<EnrichmentInput>,
  what: string
): Promise<EnrichmentOutcome> {
  let outcome: EnrichmentOutcome;
  try {
    const engine = await resolveEngine(ctx.workspaceId);
    outcome = await engine.enrich({
      prospectId: target.prospectId,
      companyDomain: target.domain,
      companyName: target.companyName,
      fullName: target.fullName,
      linkedinUrl: target.linkedinUrl,
      ...extra,
    });
  } catch {
    // Providers not configured, or the waterfall itself failed: nothing charged.
    throw unavailable(what);
  }
  await createProviderCostRecorder(deps.db, deps.env.PROVIDER_UNIT_COSTS_JSON)(providerCallsFromAttempts(outcome.attempts), {
    source: "enrichment",
    workspaceId: ctx.workspaceId,
    apiKeyId: ctx.apiKeyId,
    requestId: ctx.requestId,
  });
  return outcome;
}

const provenance = (now: Date): Provenance => ({
  source_class: "external",
  retrieved_at: now.toISOString(),
  expires_at: new Date(now.getTime() + CONTACT_FRESHNESS_MS).toISOString(),
});
const personRef = (t: Target): PersonRef => ({ id: t.publicId, full_name: t.fullName, company_domain: t.domain });

// --- POST /contacts/email/find (PAPI-055) ---------------------------------------------

/** The verified email the waterfall produced, or null. Throws when every provider call failed. */
export function verifiedEmailFrom(outcome: EnrichmentOutcome): string | null {
  const status = outcome.results.find((r) => r.field === "email_status")?.value;
  const email = outcome.results.find((r) => r.field === "email" && r.isPrimary && r.value)?.value;
  if (status === "valid" && email) return email.trim().toLowerCase();
  const calls = outcome.attempts.filter((a) => a.status !== "skipped" && a.provider !== "internal_graph");
  if (calls.length > 0 && calls.every((a) => a.status === "error")) throw unavailable("Email find");
  return null;
}

export function createEmailFindEndpoint(deps: ContactsDeps): PublicEndpoint<typeof contactFindInput, FoundEmail> {
  const resolveEngine = deps.resolveEngine ?? ((ws: string) => resolveWorkspaceEngine(deps.db, deps.env, ws));
  return {
    method: "POST",
    path: "/contacts/email/find",
    scope: "contacts:reveal",
    operation: "contacts.email_find",
    input: contactFindInput,
    maxCost: (_i, prices) => prices["contacts.email_find"].credits,

    async handle({ input, workspaceId, apiKeyId, requestId, prices, ids }) {
      const target = await resolveTarget(deps, workspaceId, ids, input);

      // The same person's email within 30 days: free, unless the workspace has since suppressed it.
      const cached = await getCachedDatum<FoundEmail>(deps.db, workspaceId, target.subject, "email");
      if (cached) {
        if ((await suppressedEmailsAmong(deps.db, workspaceId, [cached.email])).size > 0) throw new PublicApiError("not_found", "No verified email found.");
        return { data: cached, charge: 0 };
      }

      const outcome = await runWaterfall(deps, resolveEngine, { workspaceId, apiKeyId, requestId }, target, { fields: ["email", "validation"] }, "Email find");
      const email = verifiedEmailFrom(outcome);
      // No verified email, or one the workspace suppressed: not found, nothing charged (CRED-4, §9.6).
      if (!email || (await suppressedEmailsAmong(deps.db, workspaceId, [email])).size > 0) {
        throw new PublicApiError("not_found", "No verified email found.");
      }
      const now = new Date();
      const data: FoundEmail = { person: personRef(target), email, status: "valid", provenance: provenance(now) };
      await recordChargedDatum(deps.db, workspaceId, target.subject, "email", data, now);
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

// --- POST /contacts/phone/find (PAPI-056) ---------------------------------------------

/**
 * The person's phone number from the waterfall, or null. Sample (free-tier demo) data never counts.
 * Throws when no phone provider could be reached at all.
 */
export function phoneFrom(outcome: EnrichmentOutcome): { phone: string; type: "mobile" | "direct" } | null {
  const hit = outcome.results.find((r) => r.field === "phone" && r.isPrimary);
  const data = hit?.valueJson as PhoneData | undefined;
  if (data && !data.sampleData) {
    if (data.mobile?.trim()) return { phone: data.mobile.trim(), type: "mobile" };
    if (data.direct?.trim()) return { phone: data.direct.trim(), type: "direct" };
  }
  const calls = outcome.attempts.filter((a) => a.operation === "fetchPhone");
  if (calls.length === 0 || calls.every((a) => a.status === "error")) throw unavailable("Phone find");
  return null;
}

/**
 * Phone waterfall (PRD §7.3: "Find a phone number for a person. Billed only when found."). Priced
 * contacts.phone_find. The in-app lead-score gate on phone lookups does not apply here: the caller
 * asked for this person's number explicitly and pays only when one is found.
 */
export function createPhoneFindEndpoint(deps: ContactsDeps): PublicEndpoint<typeof contactFindInput, FoundPhone> {
  const resolveEngine = deps.resolveEngine ?? ((ws: string) => resolveWorkspaceEngine(deps.db, deps.env, ws));
  return {
    method: "POST",
    path: "/contacts/phone/find",
    scope: "contacts:reveal",
    operation: "contacts.phone_find",
    input: contactFindInput,
    maxCost: (_i, prices) => prices["contacts.phone_find"].credits,

    async handle({ input, workspaceId, apiKeyId, requestId, prices, ids }) {
      const target = await resolveTarget(deps, workspaceId, ids, input);
      const cached = await getCachedDatum<FoundPhone>(deps.db, workspaceId, target.subject, "phone");
      if (cached) return { data: cached, charge: 0 };

      // A verified email the workspace already found for this person helps the phone providers.
      const knownEmail = (await getCachedDatum<FoundEmail>(deps.db, workspaceId, target.subject, "email"))?.email;
      const outcome = await runWaterfall(
        deps,
        resolveEngine,
        { workspaceId, apiKeyId, requestId },
        target,
        { fields: ["phone"], email: knownEmail, leadScore: Number.POSITIVE_INFINITY },
        "Phone find"
      );
      const found = phoneFrom(outcome);
      if (!found) throw new PublicApiError("not_found", "No phone number found.");
      const now = new Date();
      const data: FoundPhone = { person: personRef(target), ...found, provenance: provenance(now) };
      await recordChargedDatum(deps.db, workspaceId, target.subject, "phone", data, now);
      return { data, charge: prices["contacts.phone_find"].credits };
    },

    fixture: (input) => ({
      person: { id: "per_test_ada", full_name: input.full_name ?? "Ada Lovelace", company_domain: "example.com" },
      phone: "+44 20 7946 0000",
      type: "mobile",
      provenance: { source_class: "external", retrieved_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-04-01T00:00:00.000Z" },
    }),
  };
}
