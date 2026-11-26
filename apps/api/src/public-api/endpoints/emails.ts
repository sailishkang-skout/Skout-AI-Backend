import { z } from "zod";
import type { Db } from "@skout/db";
import type { Env } from "../../config/env.js";
import { verifyEmailResolved, type EmailIntelStatus, type EmailIntelVerifyResult } from "../../services/email-intel.service.js";
import { createProviderCostRecorder } from "../../services/provider-cost.service.js";
import { PublicApiError } from "../errors.js";
import type { PublicEndpoint } from "../pipeline.js";

/**
 * POST /emails/verify (PAPI-057, public API PRD §7.3, §8, D5, RL-5).
 *
 * The same verification as the app's /email-intel/verify (Skout's email-intel service, with the
 * Hunter fallback for webmail). Priced emails.verify, which is 0 by default (D5) and can be raised
 * through config; every verification counts toward the key's daily verification quota (RL-5), and
 * a failed one gives the unit back. The response never names the service or provider used.
 */
export type PublicVerifyStatus = "valid" | "invalid" | "risky" | "catch_all" | "unknown";

export interface VerifiedEmail {
  email: string;
  status: PublicVerifyStatus;
  disposable: boolean;
  catch_all: boolean;
  /** Set when the domain looks like a typo of a common one (e.g. gmial.com → gmail.com). */
  suggested_domain: string | null;
  checked_at: string;
}

export interface EmailsDeps {
  env: Env;
  db: Db;
  /** The verifier; tests inject a fake one. */
  verify?: (email: string) => Promise<EmailIntelVerifyResult>;
}

const STATUS: Record<EmailIntelStatus, PublicVerifyStatus> = {
  VERIFIED: "valid",
  INVALID: "invalid",
  CATCH_ALL: "catch_all",
  TEMPORARY: "risky",
  NO_MX: "unknown",
  DNS_ERROR: "unknown",
  SMTP_ERROR: "unknown",
  UNKNOWN: "unknown",
};

/** Public verdict for one verification result. A disposable mailbox is never "valid", only "risky". */
export function toPublicVerification(email: string, r: EmailIntelVerifyResult, now = new Date()): VerifiedEmail {
  const raw = r.success && r.verificationStatus?.status ? (STATUS[r.verificationStatus.status] ?? "unknown") : "unknown";
  const status: PublicVerifyStatus = raw === "valid" && r.disposable ? "risky" : raw;
  return {
    email,
    status,
    disposable: Boolean(r.disposable),
    catch_all: Boolean(r.catchAll ?? status === "catch_all"),
    suggested_domain: typeof r.suggestedDomain === "string" && r.suggestedDomain ? r.suggestedDomain : null,
    checked_at: now.toISOString(),
  };
}

const verifyInput = z.object({ email: z.string().trim().toLowerCase().max(254).email() }).strict();

export function createVerifyEmailEndpoint(deps: EmailsDeps): PublicEndpoint<typeof verifyInput, VerifiedEmail> {
  const verify = deps.verify ?? ((email: string) => verifyEmailResolved(deps.env, email));
  const recordCosts = createProviderCostRecorder(deps.db, deps.env.PROVIDER_UNIT_COSTS_JSON);
  return {
    method: "POST",
    path: "/emails/verify",
    scope: "email:verify",
    operation: "emails.verify",
    input: verifyInput,
    maxCost: (_i, prices) => prices["emails.verify"].credits,
    // RL-5: each verification counts toward the key's daily quota.
    quota: { kind: "verify", units: () => 1 },

    async handle({ input, workspaceId, apiKeyId, requestId, prices }) {
      let result: EmailIntelVerifyResult;
      try {
        result = await verify(input.email);
      } catch {
        throw new PublicApiError("upstream_unavailable", "Email verification is temporarily unavailable. Nothing was charged; try again.");
      }
      // The webmail fallback is a paid provider call (PAPI-013); Skout's own service is not.
      if (result.provider === "hunter-fallback") {
        await recordCosts([{ provider: "hunter", operation: "verify", outcome: "ok", units: 1, credentialSource: "platform" }], {
          source: "enrichment",
          workspaceId,
          apiKeyId,
          requestId,
        });
      }
      return { data: toPublicVerification(input.email, result), charge: prices["emails.verify"].credits, quotaUsed: 1 };
    },

    fixture: (input) => ({
      email: input.email,
      status: input.email.endsWith("@example.com") ? "valid" : "unknown",
      disposable: false,
      catch_all: false,
      suggested_domain: null,
      checked_at: "2026-01-01T00:00:00.000Z",
    }),
  };
}
