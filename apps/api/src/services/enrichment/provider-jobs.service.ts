import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { recordPrivilegedAction } from "@skout/auth";
import { captureException, createLogger } from "@skout/observability";
import type { Env } from "../../config/env.js";
import { buildEntitlementsService } from "../entitlements.service.js";
import { isDatabaseError } from "../../utils/http.js";
import { recordObservedFacts, readRetentionDays } from "./capture-evidence.js";
import { companyIdFromCompanyUrl, publicIdFromProfileUrl } from "./capture-identity.js";
import { addLinkedinUrl, CaptureError, type CaptureActor } from "./capture-ingest.service.js";
import {
  activeProviderConnection,
  getProviderConnection,
  markConnectionError,
  resolveCredentialRef,
} from "./provider-connections.service.js";
import { PROVIDER_POLICIES, providerPermission, type ProviderPermission } from "./provider-policy.js";
import {
  extractObservations,
  fetchUnipileProfile,
  ProviderRequestError,
  type ProviderTargetType,
  type UnipileProfileRequest,
  type UnipileProfileResponse,
} from "./unipile-profile.adapter.js";

/**
 * ENR-04 — durable LinkedIn provider jobs on `enrichment_jobs` / `enrichment_attempts`.
 *
 * The database row is the job. The queue only says "look at this job now": a worker claims the
 * row with one conditional UPDATE, holds it under a lease while it runs, and writes a terminal
 * status when it is done. If the worker or the API dies, the row is still there — queued, or
 * running with a lease that runs out — and `recoverProviderJobs` puts it back in line or fails
 * it where everyone can see. A job never reports success it did not record.
 *
 * Retries are bounded: `max_attempts` per job, exponential backoff between attempts, and only
 * for failures another attempt can fix (timeouts, 5xx, rate limits).
 */

const log = createLogger("enrichment.provider-jobs");
const { enrichmentJobs, enrichmentAttempts, prospectActivations } = schema;

type JobRow = typeof enrichmentJobs.$inferSelect;
type AttemptRow = typeof enrichmentAttempts.$inferSelect;

export const PROVIDER_JOB_KIND = "linkedin_profile";
export const DAILY_JOB_LIMIT_ENTITLEMENT = "enrichment.provider_daily_job_limit";
export const DEFAULT_DAILY_JOB_LIMIT = 200;
export const DEFAULT_MAX_ATTEMPTS = 3;

/** How long a worker may hold a job before it is considered lost. One provider request takes at most the request timeout. */
const LEASE_MS = 5 * 60 * 1000;
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;
/** A queued job that nothing has touched for this long is handed to the queue again. */
const REQUEUE_AFTER_MS = 60 * 1000;
/** A waterfall job runs inside one request; one still unfinished after this long has lost its process. */
const WATERFALL_ABANDONED_AFTER_MS = 30 * 60 * 1000;

export type ProviderJobStatus = "queued" | "running" | "partial" | "action_required" | "failed" | "done";

const ACTIVE_STATUSES = ["queued", "running"];

export const JOB_ERRORS = {
  PROVIDER_NOT_PERMITTED: "PROVIDER_NOT_PERMITTED",
  PROVIDER_CONNECTION_REQUIRED: "PROVIDER_CONNECTION_REQUIRED",
  PROVIDER_CREDENTIAL_REQUIRED: "PROVIDER_CREDENTIAL_REQUIRED",
  PROVIDER_CREDENTIAL_REJECTED: "PROVIDER_CREDENTIAL_REJECTED",
  PROVIDER_ACCOUNT_UNAVAILABLE: "PROVIDER_ACCOUNT_UNAVAILABLE",
  PROVIDER_RATE_LIMITED: "PROVIDER_RATE_LIMITED",
  PROVIDER_REQUEST_FAILED: "PROVIDER_REQUEST_FAILED",
  PROVIDER_RESPONSE_INVALID: "PROVIDER_RESPONSE_INVALID",
  PROFILE_NOT_FOUND: "PROFILE_NOT_FOUND",
  RETRY_SCHEDULED: "RETRY_SCHEDULED",
  WORKER_INTERRUPTED: "WORKER_INTERRUPTED",
  WORKER_LOST: "WORKER_LOST",
  ATTEMPTS_EXHAUSTED: "ATTEMPTS_EXHAUSTED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export interface ProviderJobDto {
  id: string;
  correlationId: string;
  status: ProviderJobStatus;
  /** True once the job will not change again. */
  terminal: boolean;
  targetType: ProviderTargetType;
  /** Prospect id for a person, company id for a company. */
  targetId: string;
  sourceUrl: string | null;
  normalizedUrl: string | null;
  provider: string | null;
  providerConnectionId: string | null;
  trigger: string;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  errorCode: string | null;
  /** Why the job is in this state and what to do about it. */
  errorMessage: string | null;
  result: Record<string, unknown> | null;
  testMode: boolean;
  requestedBy: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface ProviderJobAttemptDto {
  id: string;
  order: number;
  provider: string;
  operation: string;
  status: string;
  latencyMs: number | null;
  errorMessage: string | null;
  attemptedAt: string;
  completedAt: string | null;
  /** The raw provider response is kept as evidence; it is read through its own endpoint. */
  hasRawResponse: boolean;
}

function publicStatus(status: string): ProviderJobStatus {
  if (status === "completed") return "done";
  if (status === "queued" || status === "running" || status === "partial" || status === "action_required" || status === "failed") {
    return status;
  }
  // "pending" predates queued; anything unknown is shown as not finished rather than as success.
  return "queued";
}

export function toProviderJobDto(row: JobRow): ProviderJobDto {
  const status = publicStatus(row.status);
  return {
    id: row.id,
    correlationId: row.correlationId,
    status,
    terminal: status !== "queued" && status !== "running",
    targetType: (row.targetType ?? "person") as ProviderTargetType,
    targetId: row.prospectId,
    sourceUrl: row.sourceUrl,
    normalizedUrl: row.normalizedUrl,
    provider: row.provider,
    providerConnectionId: row.providerConnectionId,
    trigger: row.trigger,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    result: (row.result as Record<string, unknown> | null) ?? null,
    testMode: row.testMode,
    requestedBy: row.requestedBy,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAttemptDto(row: AttemptRow): ProviderJobAttemptDto {
  return {
    id: row.id,
    order: row.attemptOrder,
    provider: row.provider,
    operation: row.operation,
    status: row.status,
    latencyMs: row.latencyMs,
    errorMessage: row.errorMessage,
    attemptedAt: row.attemptedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    hasRawResponse: row.responseOutput !== null,
  };
}

const providerJob = (workspaceId: string) => and(eq(enrichmentJobs.workspaceId, workspaceId), eq(enrichmentJobs.kind, PROVIDER_JOB_KIND));

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code ?? (error as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505";
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function readDailyLimit(db: Db, workspaceId: string): Promise<number> {
  const value = await buildEntitlementsService(db)!.getValueOr<unknown>(workspaceId, DAILY_JOB_LIMIT_ENTITLEMENT, DEFAULT_DAILY_JOB_LIMIT);
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : DEFAULT_DAILY_JOB_LIMIT;
}

// ── Create / read ────────────────────────────────────────────────────────────

export interface CreateProviderJobInput {
  url: string;
  /** From the Idempotency-Key header; a repeat returns the first job. */
  idempotencyKey?: string;
}

export interface CreateProviderJobResult {
  job: ProviderJobDto;
  /** True when an existing job was returned instead of a new one. */
  reused: boolean;
}

/**
 * Registers the LinkedIn URL (no external request) and queues one provider job for it. A URL
 * that already has an unfinished job gets that job back: two jobs never run for one target.
 */
export async function createProviderJob(db: Db, actor: CaptureActor, input: CreateProviderJobInput): Promise<CreateProviderJobResult> {
  const { workspaceId } = actor;
  const idempotencyKey = input.idempotencyKey?.trim() || undefined;
  if (idempotencyKey) {
    const [existing] = await db
      .select()
      .from(enrichmentJobs)
      .where(and(providerJob(workspaceId), eq(enrichmentJobs.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existing) return { job: toProviderJobDto(existing), reused: true };
  }

  const registered = await addLinkedinUrl(db, actor, input.url);
  const normalizedUrl = registered.linkedinUrl;
  const targetType: ProviderTargetType = registered.kind;
  const targetId = registered.kind === "person" ? registered.prospectId : registered.companyId;

  const activeForUrl = () =>
    db
      .select()
      .from(enrichmentJobs)
      .where(and(providerJob(workspaceId), eq(enrichmentJobs.normalizedUrl, normalizedUrl), inArray(enrichmentJobs.status, ACTIVE_STATUSES)))
      .limit(1);
  const [active] = await activeForUrl();
  if (active) return { job: toProviderJobDto(active), reused: true };

  const now = new Date();
  const limit = await readDailyLimit(db, workspaceId);
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(enrichmentJobs)
    .where(and(providerJob(workspaceId), gte(enrichmentJobs.queuedAt, startOfUtcDay(now))));
  if (count >= limit) {
    throw new CaptureError("provider_daily_limit_reached", 429, `This workspace has reached its limit of ${limit} provider enrichment jobs for today.`);
  }

  let activationId: string | null = null;
  if (registered.kind === "person") {
    const [activation] = await db
      .select({ id: prospectActivations.id })
      .from(prospectActivations)
      .where(and(eq(prospectActivations.workspaceId, workspaceId), eq(prospectActivations.prospectId, registered.prospectId)))
      .limit(1);
    activationId = activation?.id ?? null;
  }
  const [previous] = await db
    .select({ id: enrichmentJobs.id })
    .from(enrichmentJobs)
    .where(and(providerJob(workspaceId), eq(enrichmentJobs.normalizedUrl, normalizedUrl)))
    .limit(1);
  const trigger = previous ? "re_enrich" : "manual";
  const connection = await activeProviderConnection(db, workspaceId, "unipile");

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(enrichmentJobs)
        .values({
          workspaceId,
          prospectId: targetId,
          activationId,
          status: "queued",
          trigger,
          fieldsRequested: ["linkedin_profile"],
          kind: PROVIDER_JOB_KIND,
          targetType,
          sourceUrl: input.url,
          normalizedUrl,
          provider: "unipile",
          providerConnectionId: connection?.id ?? null,
          idempotencyKey: idempotencyKey ?? null,
          maxAttempts: DEFAULT_MAX_ATTEMPTS,
          requestedBy: actor.userId,
          queuedAt: now,
          updatedAt: now,
        })
        .returning();
      await recordPrivilegedAction(tx, {
        workspaceId,
        actorId: actor.userId,
        action: trigger === "re_enrich" ? "enrichment.re-enrich" : "enrichment.enrich",
        entityType: targetType === "person" ? "prospect" : "company",
        entityId: row!.id,
        afterState: { jobId: row!.id, correlationId: row!.correlationId, targetType, targetId, normalizedUrl, provider: "unipile" },
      });
      log.info("provider job queued", { workspaceId, jobId: row!.id, correlationId: row!.correlationId, targetType, trigger });
      return { job: toProviderJobDto(row!), reused: false };
    });
  } catch (error) {
    // Lost a race with another create for the same URL or key: hand back the job that won.
    if (!isUniqueViolation(error)) throw error;
    const [winner] = idempotencyKey
      ? await db
          .select()
          .from(enrichmentJobs)
          .where(and(providerJob(workspaceId), eq(enrichmentJobs.idempotencyKey, idempotencyKey)))
          .limit(1)
      : [];
    const existing = winner ?? (await activeForUrl())[0];
    if (!existing) throw error;
    return { job: toProviderJobDto(existing), reused: true };
  }
}

export async function getProviderJob(db: Db, workspaceId: string, jobId: string) {
  const [row] = await db
    .select()
    .from(enrichmentJobs)
    .where(and(providerJob(workspaceId), eq(enrichmentJobs.id, jobId)))
    .limit(1);
  if (!row) return null;
  const attempts = await db
    .select()
    .from(enrichmentAttempts)
    .where(eq(enrichmentAttempts.enrichmentJobId, jobId))
    .orderBy(asc(enrichmentAttempts.attemptOrder));
  return { job: toProviderJobDto(row), attempts: attempts.map(toAttemptDto) };
}

/** The raw provider response kept for one attempt, or null when there is none (or it has expired). */
export async function getAttemptRawResponse(db: Db, workspaceId: string, jobId: string, attemptId: string) {
  const [row] = await db
    .select({ responseOutput: enrichmentAttempts.responseOutput, attemptedAt: enrichmentAttempts.attemptedAt, provider: enrichmentAttempts.provider })
    .from(enrichmentAttempts)
    .innerJoin(enrichmentJobs, eq(enrichmentJobs.id, enrichmentAttempts.enrichmentJobId))
    .where(and(providerJob(workspaceId), eq(enrichmentJobs.id, jobId), eq(enrichmentAttempts.id, attemptId)))
    .limit(1);
  if (!row || row.responseOutput === null) return null;
  return { provider: row.provider, retrievedAt: row.attemptedAt.toISOString(), response: row.responseOutput };
}

export interface ProviderJobFilters {
  status?: ProviderJobStatus;
  targetId?: string;
  page: number;
  pageSize: number;
}

export async function listProviderJobs(db: Db, workspaceId: string, filters: ProviderJobFilters) {
  const where = and(
    providerJob(workspaceId),
    filters.status ? eq(enrichmentJobs.status, filters.status === "done" ? "completed" : filters.status) : undefined,
    filters.targetId ? eq(enrichmentJobs.prospectId, filters.targetId) : undefined
  );
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select()
      .from(enrichmentJobs)
      .where(where)
      .orderBy(desc(enrichmentJobs.queuedAt))
      .limit(filters.pageSize)
      .offset((filters.page - 1) * filters.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(enrichmentJobs).where(where),
  ]);
  return { data: rows.map(toProviderJobDto), total, page: filters.page, pageSize: filters.pageSize };
}

// ── Run ──────────────────────────────────────────────────────────────────────

export interface ProviderJobDeps {
  fetchProfile: (request: UnipileProfileRequest) => Promise<UnipileProfileResponse>;
  permission: (config: Env) => ProviderPermission;
  now: () => Date;
}

const defaultDeps: ProviderJobDeps = {
  fetchProfile: fetchUnipileProfile,
  permission: (config) => providerPermission(config, "unipile"),
  now: () => new Date(),
};

export type RunOutcome =
  /** Another worker has it, it is not due yet, or it is already terminal. */
  | { state: "skipped" }
  | { state: "terminal"; status: ProviderJobStatus }
  /** Back in the queue; the caller schedules the next look at `retryAt`. */
  | { state: "retry_scheduled"; retryAt: Date };

export function isTestMode(config: Pick<Env, "LINKEDIN_ENRICHMENT_TEST_MODE" | "NODE_ENV">): boolean {
  return config.LINKEDIN_ENRICHMENT_TEST_MODE === true && config.NODE_ENV !== "production";
}

export function backoffMs(attempt: number, retryAfterMs: number | null = null): number {
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempt - 1, 0), BACKOFF_MAX_MS);
  return Math.max(exponential, retryAfterMs ?? 0);
}

async function claim(db: Db, jobId: string, now: Date): Promise<JobRow | null> {
  const [row] = await db
    .update(enrichmentJobs)
    .set({
      status: "running",
      attemptCount: sql`${enrichmentJobs.attemptCount} + 1`,
      startedAt: sql`coalesce(${enrichmentJobs.startedAt}, ${now.toISOString()}::timestamptz)`,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(enrichmentJobs.id, jobId),
        eq(enrichmentJobs.kind, PROVIDER_JOB_KIND),
        or(
          and(eq(enrichmentJobs.status, "queued"), or(isNull(enrichmentJobs.nextAttemptAt), lte(enrichmentJobs.nextAttemptAt, now))),
          and(eq(enrichmentJobs.status, "running"), lt(enrichmentJobs.leaseExpiresAt, now))
        )
      )
    )
    .returning();
  return row ?? null;
}

/** Writes only while this worker still holds the job, so a worker that lost its lease cannot overwrite the outcome. */
async function settle(db: Db, job: JobRow, patch: Partial<typeof enrichmentJobs.$inferInsert>, now: Date): Promise<boolean> {
  const updated = await db
    .update(enrichmentJobs)
    .set({ ...patch, leaseExpiresAt: null, updatedAt: now })
    .where(and(eq(enrichmentJobs.id, job.id), eq(enrichmentJobs.status, "running"), eq(enrichmentJobs.attemptCount, job.attemptCount)))
    .returning({ id: enrichmentJobs.id });
  return updated.length > 0;
}

async function finish(
  db: Db,
  job: JobRow,
  now: Date,
  status: "partial" | "action_required" | "failed" | "completed",
  detail: { errorCode?: string; errorMessage?: string; result?: Record<string, unknown>; testMode?: boolean }
): Promise<RunOutcome> {
  const held = await settle(
    db,
    job,
    {
      status,
      errorCode: detail.errorCode ?? null,
      errorMessage: detail.errorMessage ?? null,
      result: detail.result ?? null,
      completedAt: now,
      ...(detail.testMode === undefined ? {} : { testMode: detail.testMode }),
    },
    now
  );
  if (!held) return { state: "skipped" };
  const logFields = { workspaceId: job.workspaceId, jobId: job.id, correlationId: job.correlationId, status, errorCode: detail.errorCode, attempt: job.attemptCount };
  if (status === "failed") log.warn("provider job failed", logFields);
  else log.info("provider job finished", logFields);
  return { state: "terminal", status: publicStatus(status) };
}

async function recordAttempt(
  db: Db,
  job: JobRow,
  now: Date,
  attempt: {
    provider: string;
    operation: string;
    status: "ok" | "error" | "skipped";
    requestInput: Record<string, unknown>;
    responseOutput?: Record<string, unknown> | null;
    latencyMs?: number | null;
    errorMessage?: string | null;
  }
): Promise<string> {
  const [{ next } = { next: 1 }] = await db
    .select({ next: sql<number>`coalesce(max(${enrichmentAttempts.attemptOrder}), 0)::int + 1` })
    .from(enrichmentAttempts)
    .where(eq(enrichmentAttempts.enrichmentJobId, job.id));
  const [row] = await db
    .insert(enrichmentAttempts)
    .values({
      enrichmentJobId: job.id,
      attemptOrder: next,
      provider: attempt.provider,
      operation: attempt.operation,
      status: attempt.status,
      requestInput: { ...attempt.requestInput, correlationId: job.correlationId, jobAttempt: job.attemptCount },
      responseOutput: attempt.responseOutput ?? null,
      latencyMs: attempt.latencyMs ?? null,
      errorMessage: attempt.errorMessage ?? null,
      attemptedAt: now,
      completedAt: now,
    })
    .returning({ id: enrichmentAttempts.id });
  return row!.id;
}

async function scheduleRetry(db: Db, job: JobRow, now: Date, reason: string, retryAfterMs: number | null): Promise<RunOutcome> {
  const retryAt = new Date(now.getTime() + backoffMs(job.attemptCount, retryAfterMs));
  const held = await settle(
    db,
    job,
    {
      status: "queued",
      nextAttemptAt: retryAt,
      errorCode: JOB_ERRORS.RETRY_SCHEDULED,
      errorMessage: `${reason} Attempt ${job.attemptCount} of ${job.maxAttempts}; trying again automatically.`,
    },
    now
  );
  if (!held) return { state: "skipped" };
  log.info("provider job retry scheduled", { workspaceId: job.workspaceId, jobId: job.id, correlationId: job.correlationId, attempt: job.attemptCount, retryAt: retryAt.toISOString() });
  return { state: "retry_scheduled", retryAt };
}

function identifierOf(job: JobRow): string | undefined {
  if (!job.normalizedUrl) return undefined;
  return job.targetType === "company" ? companyIdFromCompanyUrl(job.normalizedUrl) : publicIdFromProfileUrl(job.normalizedUrl);
}

/**
 * Claims and runs one job. Safe to call for any job id at any time, from any number of
 * workers: a job that is not due, is held by a live worker, or is already terminal is skipped.
 */
export async function runProviderJob(db: Db, config: Env, jobId: string, overrides: Partial<ProviderJobDeps> = {}): Promise<RunOutcome> {
  const deps = { ...defaultDeps, ...overrides };
  const now = deps.now();
  const job = await claim(db, jobId, now);
  if (!job) return { state: "skipped" };

  if (job.attemptCount > job.maxAttempts) {
    return finish(db, job, now, "failed", {
      errorCode: JOB_ERRORS.ATTEMPTS_EXHAUSTED,
      errorMessage: `The job did not finish in ${job.maxAttempts} attempts. Start it again to retry.`,
    });
  }

  try {
    return await execute(db, config, job, deps, now);
  } catch (error) {
    log.error("provider job hit an unexpected error", error, { workspaceId: job.workspaceId, jobId: job.id, correlationId: job.correlationId });
    captureException(error, { module: "enrichment.provider-jobs", workspaceId: job.workspaceId, jobId: job.id });
    if (job.attemptCount < job.maxAttempts) {
      return scheduleRetry(db, job, deps.now(), "The job stopped on an internal error.", null);
    }
    return finish(db, job, deps.now(), "failed", {
      errorCode: JOB_ERRORS.INTERNAL_ERROR,
      errorMessage: isDatabaseError(error) ? "The job failed on a server error." : "The job failed on an internal error.",
    });
  }
}

async function execute(db: Db, config: Env, job: JobRow, deps: ProviderJobDeps, now: Date): Promise<RunOutcome> {
  const targetType = (job.targetType ?? "person") as ProviderTargetType;

  // Test mode proves the lifecycle — queue, claim, terminal status, UI polling — and nothing
  // else. It records the URL that was submitted, calls nobody, and creates no profile fact.
  if (isTestMode(config)) {
    const attemptId = await recordAttempt(db, job, now, {
      provider: "test_mode",
      operation: "record_submitted_url",
      status: "skipped",
      requestInput: { normalizedUrl: job.normalizedUrl },
    });
    return finish(db, job, now, "partial", {
      testMode: true,
      result: {
        mode: "test",
        externalCallMade: false,
        submittedUrl: job.normalizedUrl,
        attemptId,
        message: "Test mode: the job ran end to end. No provider was called and no profile fields were created.",
      },
    });
  }

  const permission = deps.permission(config);
  if (!permission.permitted) {
    return finish(db, job, now, "action_required", { errorCode: JOB_ERRORS.PROVIDER_NOT_PERMITTED, errorMessage: permission.reason ?? "This provider is not permitted." });
  }

  // A job queued before a provider was connected picks the connection up when it runs.
  const connection = job.providerConnectionId
    ? await getProviderConnection(db, job.workspaceId, job.providerConnectionId)
    : await activeProviderConnection(db, job.workspaceId, "unipile");
  const usable = connection?.status === "active" ? connection : await activeProviderConnection(db, job.workspaceId, "unipile");
  if (!usable) {
    return finish(db, job, now, "action_required", {
      errorCode: JOB_ERRORS.PROVIDER_CONNECTION_REQUIRED,
      errorMessage: "Connect an authorised LinkedIn provider account before background enrichment can run.",
    });
  }
  if (usable.id !== job.providerConnectionId) {
    await db.update(enrichmentJobs).set({ providerConnectionId: usable.id }).where(eq(enrichmentJobs.id, job.id));
  }

  const credential = await resolveCredentialRef(db, config, job.workspaceId, usable.credentialRef);
  if (!credential) {
    await markConnectionError(db, job.workspaceId, usable.id, "provider_credential_required");
    return finish(db, job, now, "action_required", {
      errorCode: JOB_ERRORS.PROVIDER_CREDENTIAL_REQUIRED,
      errorMessage: "The provider credential for this connection is missing. Add it under Settings → Integrations.",
    });
  }

  const identifier = identifierOf(job);
  if (!identifier) {
    return finish(db, job, now, "failed", { errorCode: JOB_ERRORS.PROVIDER_RESPONSE_INVALID, errorMessage: "The job has no usable LinkedIn URL." });
  }

  const request: UnipileProfileRequest = {
    baseUrl: config.UNIPILE_V2_BASE_URL || credential.baseUrl,
    apiKey: credential.apiKey,
    accountId: usable.externalAccountId,
    targetType,
    identifier,
    timeoutMs: config.ENRICHMENT_PROVIDER_TIMEOUT_MS,
  };

  let response: UnipileProfileResponse;
  try {
    response = await deps.fetchProfile(request);
  } catch (error) {
    if (!(error instanceof ProviderRequestError)) throw error;
    const failedAt = deps.now();
    await recordAttempt(db, job, failedAt, {
      provider: "unipile",
      operation: targetType === "person" ? "get_person_profile" : "get_company_profile",
      status: "error",
      requestInput: { accountId: usable.externalAccountId, identifier, credentialSource: credential.source },
      errorMessage: error.message,
    });
    return failed(db, job, usable.id, failedAt, error);
  }

  const finishedAt = deps.now();
  const attemptId = await recordAttempt(db, job, finishedAt, {
    provider: "unipile",
    operation: targetType === "person" ? "get_person_profile" : "get_company_profile",
    status: "ok",
    requestInput: { path: response.requestPath, accountId: usable.externalAccountId, credentialSource: credential.source },
    // The whole response is the evidence. Mapped values are read from it, never instead of it.
    responseOutput: response.payload,
    latencyMs: response.latencyMs,
  });

  const extracted = extractObservations(targetType, response.payload);
  const promoted = Object.keys(extracted.promotable);
  if (promoted.length) {
    await recordObservedFacts(db, {
      workspaceId: job.workspaceId,
      entityType: targetType === "person" ? "prospect" : "company",
      entityId: job.prospectId,
      origin: "providerProfile",
      sourceUrl: job.normalizedUrl ?? undefined,
      observedAt: finishedAt,
      retentionDays: await readRetentionDays(db, job.workspaceId),
      facts: extracted.promotable,
    });
  }

  const evidenceOnly = extracted.observations.filter((observation) => !observation.promotable);
  const complete = promoted.length > 0 && evidenceOnly.length === 0;
  const message = complete
    ? `The provider response was stored and ${promoted.length} field(s) were added as evidence.`
    : !extracted.observations.length
      ? "The provider response was stored as evidence. It contained none of the mapped fields, so nothing was added to the record."
      : `The provider response was stored as evidence. ${evidenceOnly.length} field(s) are not verified against a live provider payload yet and were not added to the record.`;
  return finish(db, job, finishedAt, complete ? "completed" : "partial", {
    result: {
      provider: "unipile",
      attemptId,
      payloadHash: response.payloadHash,
      mappingVersion: extracted.mappingVersion,
      promoted,
      evidenceOnly: evidenceOnly.map(({ attribute, mappingStatus, contactData }) => ({ attribute, mappingStatus, contactData })),
      absent: extracted.absent,
      rawResponseRetentionDays: PROVIDER_POLICIES.unipile.rawResponseRetentionDays,
      message,
    },
  });
}

async function failed(db: Db, job: JobRow, connectionId: string, now: Date, error: ProviderRequestError): Promise<RunOutcome> {
  if (error.retryable) {
    if (job.attemptCount < job.maxAttempts) return scheduleRetry(db, job, now, error.message, error.retryAfterMs);
    return finish(db, job, now, "failed", {
      errorCode: error.kind === "rate_limited" ? JOB_ERRORS.PROVIDER_RATE_LIMITED : JOB_ERRORS.PROVIDER_REQUEST_FAILED,
      errorMessage: `${error.message} The job stopped after ${job.maxAttempts} attempts.`,
    });
  }
  if (error.kind === "credential_rejected") {
    await markConnectionError(db, job.workspaceId, connectionId, "provider_credential_rejected");
    return finish(db, job, now, "action_required", {
      errorCode: JOB_ERRORS.PROVIDER_CREDENTIAL_REJECTED,
      errorMessage: "The provider rejected the stored credential. Update it under Settings → Integrations, then run the job again.",
    });
  }
  if (error.kind === "account_unavailable") {
    await markConnectionError(db, job.workspaceId, connectionId, "provider_account_unavailable");
    return finish(db, job, now, "action_required", {
      errorCode: JOB_ERRORS.PROVIDER_ACCOUNT_UNAVAILABLE,
      errorMessage: "The connected provider account cannot read this profile. Reconnect the account, then run the job again.",
    });
  }
  if (error.kind === "not_found") {
    return finish(db, job, now, "failed", { errorCode: JOB_ERRORS.PROFILE_NOT_FOUND, errorMessage: error.message });
  }
  return finish(db, job, now, "failed", { errorCode: JOB_ERRORS.PROVIDER_RESPONSE_INVALID, errorMessage: error.message });
}

// ── Recovery ─────────────────────────────────────────────────────────────────

export interface RecoveryResult {
  /** Jobs to hand to the queue now. */
  due: string[];
  /** Running jobs whose worker went away and that were queued again. */
  requeued: number;
  /** Jobs failed because their worker went away and no attempts were left. */
  failed: number;
  /** In-request waterfall jobs left unfinished by a process that died. */
  abandonedWaterfall: number;
}

/**
 * Finds every job a dead worker or a lost queue message left behind. Runs on a timer and at
 * start-up. After it, each unfinished job is either on its way to a worker or failed with a
 * reason — none is left "running" with nobody running it.
 */
export async function recoverProviderJobs(db: Db, now = new Date()): Promise<RecoveryResult> {
  const expired = and(eq(enrichmentJobs.kind, PROVIDER_JOB_KIND), eq(enrichmentJobs.status, "running"), lt(enrichmentJobs.leaseExpiresAt, now));

  const lost = await db
    .update(enrichmentJobs)
    .set({
      status: "failed",
      errorCode: JOB_ERRORS.WORKER_LOST,
      errorMessage: "The worker stopped while this job was running and no attempts were left. Start it again to retry.",
      leaseExpiresAt: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(expired, gte(enrichmentJobs.attemptCount, enrichmentJobs.maxAttempts)))
    .returning({ id: enrichmentJobs.id, workspaceId: enrichmentJobs.workspaceId, correlationId: enrichmentJobs.correlationId });
  for (const job of lost) log.warn("provider job failed: worker lost", { workspaceId: job.workspaceId, jobId: job.id, correlationId: job.correlationId });

  const interrupted = await db
    .update(enrichmentJobs)
    .set({
      status: "queued",
      errorCode: JOB_ERRORS.WORKER_INTERRUPTED,
      errorMessage: "The worker stopped while this job was running. It has been queued again.",
      leaseExpiresAt: null,
      nextAttemptAt: null,
      // Old enough to be picked up by the hand-off below in this same pass.
      updatedAt: new Date(now.getTime() - REQUEUE_AFTER_MS - 1),
    })
    .where(expired)
    .returning({ id: enrichmentJobs.id, workspaceId: enrichmentJobs.workspaceId, correlationId: enrichmentJobs.correlationId });
  for (const job of interrupted) log.warn("provider job requeued: worker interrupted", { workspaceId: job.workspaceId, jobId: job.id, correlationId: job.correlationId });

  // Touching updated_at keeps a job that is already waiting in the queue from being handed over on every pass.
  const due = await db
    .update(enrichmentJobs)
    .set({ updatedAt: now })
    .where(
      and(
        eq(enrichmentJobs.kind, PROVIDER_JOB_KIND),
        eq(enrichmentJobs.status, "queued"),
        or(isNull(enrichmentJobs.nextAttemptAt), lte(enrichmentJobs.nextAttemptAt, now)),
        lt(enrichmentJobs.updatedAt, new Date(now.getTime() - REQUEUE_AFTER_MS))
      )
    )
    .returning({ id: enrichmentJobs.id });

  const abandoned = await db
    .update(enrichmentJobs)
    .set({
      status: "failed",
      errorCode: JOB_ERRORS.WORKER_LOST,
      errorMessage: "Enrichment was interrupted before it finished. Run it again.",
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(enrichmentJobs.kind, "contact_waterfall"),
        inArray(enrichmentJobs.status, ACTIVE_STATUSES),
        lt(enrichmentJobs.queuedAt, new Date(now.getTime() - WATERFALL_ABANDONED_AFTER_MS))
      )
    )
    .returning({ id: enrichmentJobs.id });

  return { due: due.map((job) => job.id), requeued: interrupted.length, failed: lost.length, abandonedWaterfall: abandoned.length };
}

/** Removes raw provider responses older than the provider's retention period. The attempt row stays. */
export async function purgeExpiredProviderResponses(db: Db, now = new Date()): Promise<number> {
  let removed = 0;
  for (const policy of Object.values(PROVIDER_POLICIES)) {
    const cutoff = new Date(now.getTime() - policy.rawResponseRetentionDays * 24 * 60 * 60 * 1000);
    const rows = await db
      .update(enrichmentAttempts)
      .set({ responseOutput: null })
      .where(
        and(
          eq(enrichmentAttempts.provider, policy.id),
          isNotNull(enrichmentAttempts.responseOutput),
          lt(enrichmentAttempts.attemptedAt, cutoff),
          inArray(
            enrichmentAttempts.enrichmentJobId,
            db.select({ id: enrichmentJobs.id }).from(enrichmentJobs).where(eq(enrichmentJobs.kind, PROVIDER_JOB_KIND))
          )
        )
      )
      .returning({ id: enrichmentAttempts.id });
    removed += rows.length;
  }
  return removed;
}
