import { z } from "zod";
import type { Db } from "@skout/db";
import type { Env } from "../../config/env.js";
import { verifyEmailResolved, type EmailIntelStatus, type EmailIntelVerifyResult } from "../../services/email-intel.service.js";
import { createProviderCostRecorder } from "../../services/provider-cost.service.js";
import { isRedisAvailable } from "../../lib/redis.js";
import { createLogger } from "@skout/observability";
import { enqueuePublicApiJob } from "../../workers/public-api-jobs.queue.js";
import { PublicApiError } from "../errors.js";
import { API_JOB_HOLD_TTL_MS, createBatchJob, runBatchJob, type BatchRunner } from "../jobs.js";
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
  /** Starts a batch job; default: the jobs queue, or in this process when Redis is unavailable. */
  enqueue?: (jobId: string) => Promise<void>;
}

/**
 * One verification, with the webmail fallback's provider cost recorded (PAPI-013). Throws when the
 * verifier can't be reached; the caller decides what that means (503 for one, a failed item in a batch).
 */
export async function verifyOne(
  deps: EmailsDeps,
  ctx: { workspaceId: string; apiKeyId: string | null; requestId: string },
  email: string
): Promise<VerifiedEmail> {
  const result = await (deps.verify ?? ((e: string) => verifyEmailResolved(deps.env, e)))(email);
  // The webmail fallback is a paid provider call; Skout's own service is not.
  if (result.provider === "hunter-fallback") {
    await createProviderCostRecorder(deps.db, deps.env.PROVIDER_UNIT_COSTS_JSON)(
      [{ provider: "hunter", operation: "verify", outcome: "ok", units: 1, credentialSource: "platform" }],
      { source: "enrichment", ...ctx }
    );
  }
  return toPublicVerification(email, result);
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
      let data: VerifiedEmail;
      try {
        data = await verifyOne(deps, { workspaceId, apiKeyId, requestId }, input.email);
      } catch {
        throw new PublicApiError("upstream_unavailable", "Email verification is temporarily unavailable. Nothing was charged; try again.");
      }
      return { data, charge: prices["emails.verify"].credits, quotaUsed: 1 };
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

// --- POST /emails/verify/batch (PAPI-058) ------------------------------------------------

export const VERIFY_BATCH_MAX = 1_000;
const log = createLogger("public-api.emails");

/** A batch item that could not be verified (service unreachable): not charged. */
export interface FailedVerification {
  email: string;
  status: null;
  error: "verification_failed";
}

export interface QueuedJob {
  job_id: string;
  status: "queued";
  total: number;
}

const batchInput = z
  .object({
    emails: z.array(z.string().trim().toLowerCase().max(254).email()).min(1).max(VERIFY_BATCH_MAX),
  })
  .strict();

/** Unique emails, first-seen order (a repeat in the same batch is verified and charged once). */
const uniqueEmails = (emails: string[]) => [...new Set(emails)];

export function verifyBatchRunner(deps: EmailsDeps): BatchRunner<string, VerifiedEmail | FailedVerification> {
  return {
    run: (email, ctx) => verifyOne(deps, ctx, email),
    failed: (email) => ({ email, status: null, error: "verification_failed" }),
    concurrency: 5,
  };
}

/** Runs one queued public API job (the worker, or this process when Redis is unavailable). */
export async function runPublicApiJob(db: Db, env: Env, jobId: string, verify?: EmailsDeps["verify"]) {
  return runBatchJob(db, jobId, verifyBatchRunner({ env, db, verify }));
}

/**
 * Async, up to 1,000 emails (JOB-1): reserves emails.verify × the batch at the current price, counts
 * the whole batch toward the key's daily verification quota (RL-5), answers 202 with a job id, and
 * the job charges each successfully verified email at that price and releases the rest.
 */
export function createVerifyEmailBatchEndpoint(deps: EmailsDeps): PublicEndpoint<typeof batchInput, QueuedJob> {
  const enqueue =
    deps.enqueue ??
    (async (jobId: string) => {
      if (await isRedisAvailable(deps.env)) return enqueuePublicApiJob(deps.env, { jobId });
      // No Redis (local, single instance): run it here, after the response.
      setImmediate(() => {
        runPublicApiJob(deps.db, deps.env, jobId, deps.verify).catch((err) => log.error("in-process batch job failed", err, { jobId }));
      });
    });
  return {
    method: "POST",
    path: "/emails/verify/batch",
    scope: "email:verify",
    operation: "emails.verify",
    input: batchInput,
    batch: true,
    holdTtlMs: API_JOB_HOLD_TTL_MS,
    maxCost: (input, prices) => uniqueEmails(input.emails).length * prices["emails.verify"].credits,
    quota: { kind: "verify", units: (input) => uniqueEmails(input.emails).length },

    async handle({ input, workspaceId, apiKeyId, requestId, prices, ids, holdId }) {
      const emails = uniqueEmails(input.emails);
      const jobId = await createBatchJob(deps.db, {
        workspaceId,
        apiKeyId,
        requestId,
        operation: "emails.verify",
        holdId,
        items: emails,
        pricePerItem: prices["emails.verify"].credits,
      });
      await enqueue(jobId);
      return { data: { job_id: ids.encode("job", jobId), status: "queued", total: emails.length }, charge: 0, status: 202, holdTransferred: true };
    },

    fixture: (input) => ({ job_id: "job_test_verify_batch", status: "queued", total: uniqueEmails(input.emails).length }),
  };
}
