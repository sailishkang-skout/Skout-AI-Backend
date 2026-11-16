/**
 * §5.2 / §7.1 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md. ENR-02 automatic (server-side) people capture.
 *   - Tables touched directly: companies (owned by apps/crm)
 *     - read only (the company name shown on a queued job)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: a queued job joins the capture identity key with the CRM company name in one
 *     query; people are written only through ingestCompanyCapture, the same path as the
 *     extension (capture-ingest.service.ts).
 *   - Review date: revisit once apps/crm's internal API surface fully shipped (Wave 2)
 */
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../../config/env.js";
import { UnipileError, unipileGetCompany, unipileSearchCompanyPeople, type UnipilePeopleSearchItem } from "../unipile.client.js";
import { CaptureError, ingestCompanyCapture } from "./capture-ingest.service.js";
import { companyIngestSchema } from "./capture-schemas.js";
import { linkedinIdFromSegment, normalizeLinkedinId } from "./capture-identity.js";
import { captureQueueDto, companyCaptureUrl } from "./capture-queue.service.js";

const log = createLogger("enrichment.capture-auto");

/** One automatic batch: the same 250-person cap as a reviewed extension batch. */
export const AUTO_BATCH_PEOPLE = 250;
/** Unipile returns at most 50 people per search page. */
const AUTO_PAGE_SIZE = 50;
const AUTO_MAX_PAGES_PER_BATCH = Math.ceil(AUTO_BATCH_PEOPLE / AUTO_PAGE_SIZE);
/** Pause between two batches of one company, so a company is not read in one burst. */
export const AUTO_BATCH_GAP_MS = 3 * 60 * 1000;
/** An empty or failed batch is tried again once (after this long) before the job fails. */
const AUTO_RETRY_MS = 2 * 60 * 1000;
const AUTO_MAX_ATTEMPTS = 2;
/** A job claimed by a worker that then died is picked up again after this long. */
const AUTO_STALE_RUNNING_MS = 15 * 60 * 1000;
/** Jobs started per worker pass, across workspaces. */
const AUTO_JOBS_PER_PASS = 3;

export const autoCaptureStartSchema = z
  .object({
    companyPublicIds: z
      .array(z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9%._~-]+$/, "Not a LinkedIn company ID."))
      .min(1)
      .max(200),
  })
  .strict();

export interface AutoCaptureAvailability {
  available: boolean;
  /** Why automatic capture cannot run; null when it can. */
  reason: string | null;
  account: { id: string; displayName: string | null } | null;
}

async function workspaceLinkedinAccount(db: Db, workspaceId: string) {
  const a = schema.linkedinAccounts;
  const [account] = await db
    .select({ unipileAccountId: a.unipileAccountId, displayName: a.displayName })
    .from(a)
    .where(and(eq(a.workspaceId, workspaceId), eq(a.channel, "linkedin"), eq(a.status, "active")))
    .orderBy(desc(a.isDefault), desc(a.updatedAt))
    .limit(1);
  return account ?? null;
}

/** Whether this workspace can capture people automatically, and with which LinkedIn account. */
export async function autoCaptureAvailability(
  db: Db,
  config: Pick<Env, "UNIPILE_DSN" | "UNIPILE_API_KEY">,
  workspaceId: string
): Promise<AutoCaptureAvailability> {
  if (!config.UNIPILE_DSN || !config.UNIPILE_API_KEY) {
    return { available: false, reason: "Automatic capture needs the Unipile connector, which is not configured on this server.", account: null };
  }
  const account = await workspaceLinkedinAccount(db, workspaceId);
  if (!account) {
    return {
      available: false,
      reason: "Connect a LinkedIn account to this workspace (Settings → LinkedIn accounts) to capture people automatically.",
      account: null,
    };
  }
  return { available: true, reason: null, account: { id: account.unipileAccountId, displayName: account.displayName } };
}

/** Queues automatic capture for captured companies; returns the jobs. Jobs already running are left alone. */
export async function startAutoCapture(
  db: Db,
  config: Pick<Env, "UNIPILE_DSN" | "UNIPILE_API_KEY">,
  actor: { workspaceId: string; userId: string },
  rawIds: string[]
) {
  const availability = await autoCaptureAvailability(db, config, actor.workspaceId);
  if (!availability.available) return { ok: false as const, reason: availability.reason! };
  const ids = [...new Set(rawIds.map(normalizeLinkedinId))];
  // Only companies captured in this workspace (their name comes from the CRM record).
  const c = schema.companies;
  const i = schema.enrichmentIdentities;
  const known = await db
    .select({ key: i.canonicalKey, name: c.name })
    .from(i)
    .innerJoin(c, and(eq(c.id, i.entityId), eq(c.workspaceId, i.workspaceId), isNull(c.deletedAt)))
    .where(and(eq(i.workspaceId, actor.workspaceId), eq(i.entityType, "company"), inArray(i.canonicalKey, ids.map((id) => `company:${id}`))));
  const names = new Map(known.map((row) => [row.key.slice("company:".length), row.name]));
  const table = schema.enrichmentCaptureQueue;
  const now = new Date();
  const queued: string[] = [];
  const skipped: Array<{ companyPublicId: string; reason: string }> = [];
  for (const id of ids) {
    if (!names.has(id)) {
      skipped.push({ companyPublicId: id, reason: "Capture this company first, then its people can be read." });
      continue;
    }
    const [row] = await db
      .insert(table)
      .values({
        workspaceId: actor.workspaceId,
        companyPublicId: id,
        companyName: names.get(id) ?? null,
        sourceUrl: companyCaptureUrl(id),
        mode: "unipile",
        status: "queued",
        nextRunAt: now,
        attempts: 0,
        requestedBy: actor.userId,
        updatedBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [table.workspaceId, table.companyPublicId],
        set: {
          companyName: sql`COALESCE(${names.get(id) ?? null}, ${table.companyName})`,
          mode: "unipile",
          status: "queued",
          error: null,
          nextRunAt: now,
          attempts: 0,
          // A finished company starts over from the first page, with its counts.
          cursor: sql`CASE WHEN ${table.complete} THEN NULL ELSE ${table.cursor} END`,
          pagesRead: sql`CASE WHEN ${table.complete} THEN 0 ELSE ${table.pagesRead} END`,
          peopleFound: sql`CASE WHEN ${table.complete} THEN 0 ELSE ${table.peopleFound} END`,
          batches: sql`CASE WHEN ${table.complete} THEN 0 ELSE ${table.batches} END`,
          complete: false,
          requestedBy: actor.userId,
          updatedBy: actor.userId,
          updatedAt: now,
        },
        // Never take over a job that is being read right now.
        setWhere: sql`NOT (${table.status} IN ('running', 'review') AND ${table.updatedAt} > now() - interval '15 minutes')`,
      })
      .returning();
    if (row) queued.push(id);
    else skipped.push({ companyPublicId: id, reason: "It is being read right now." });
  }
  return { ok: true as const, queued, skipped };
}

/** Pauses an automatic job; it continues from the same page when resumed. */
export async function pauseAutoCapture(db: Db, actor: { workspaceId: string; userId: string }, rawId: string) {
  const table = schema.enrichmentCaptureQueue;
  const [row] = await db
    .update(table)
    .set({ status: "paused", nextRunAt: null, updatedBy: actor.userId, updatedAt: new Date() })
    .where(
      and(
        eq(table.workspaceId, actor.workspaceId),
        eq(table.companyPublicId, normalizeLinkedinId(rawId)),
        eq(table.mode, "unipile"),
        inArray(table.status, ["queued", "running"])
      )
    )
    .returning();
  return row ? captureQueueDto(row) : null;
}

type Job = typeof schema.enrichmentCaptureQueue.$inferSelect;

/** A Unipile search result as a discovery candidate, or undefined when it has no public profile. */
export function candidateFromUnipile(item: UnipilePeopleSearchItem) {
  const raw =
    item.public_identifier ||
    (item.public_profile_url || item.profile_url || "").match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] ||
    "";
  const publicId = raw ? linkedinIdFromSegment(raw) : undefined;
  if (!publicId || publicId.length > 200) return undefined;
  const fullName = (item.name || "").trim().slice(0, 300);
  return {
    publicId,
    sourceUrl: `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`,
    ...(fullName ? { fullName } : {}),
    ...(item.headline?.trim() ? { headline: item.headline.trim().slice(0, 500) } : {}),
    associationSource: "company-search-result" as const,
  };
}

async function knownLinkedinCompanyId(db: Db, job: Job): Promise<string | null> {
  if (job.linkedinCompanyId) return job.linkedinCompanyId;
  const i = schema.enrichmentIdentities;
  const [company] = await db
    .select({ entityId: i.entityId })
    .from(i)
    .where(and(eq(i.workspaceId, job.workspaceId), eq(i.entityType, "company"), eq(i.canonicalKey, `company:${job.companyPublicId}`)))
    .limit(1);
  if (!company) return null;
  const [member] = await db
    .select({ key: i.canonicalKey })
    .from(i)
    .where(and(eq(i.workspaceId, job.workspaceId), eq(i.entityType, "company"), eq(i.entityId, company.entityId), sql`${i.canonicalKey} like 'company-member:%'`))
    .limit(1);
  return member ? member.key.slice("company-member:".length) : null;
}

async function finishJob(db: Db, job: Job, values: Partial<Job>) {
  const table = schema.enrichmentCaptureQueue;
  await db
    .update(table)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(table.workspaceId, job.workspaceId), eq(table.companyPublicId, job.companyPublicId), eq(table.mode, "unipile")));
}

/** A failed try is retried once; the second failure fails the job with the reason. */
function retryOrFail(job: Job, reason: string, now: Date): Partial<Job> {
  const attempts = job.attempts + 1;
  return attempts >= AUTO_MAX_ATTEMPTS
    ? { status: "failed", error: reason.slice(0, 500), attempts, nextRunAt: null }
    : { status: "queued", error: null, attempts, nextRunAt: new Date(now.getTime() + AUTO_RETRY_MS) };
}

/** Reads and saves one batch of a claimed job. Exported for tests. */
export async function processAutoJob(db: Db, config: Env, job: Job, now = new Date()): Promise<void> {
  const availability = await autoCaptureAvailability(db, config, job.workspaceId);
  if (!availability.available) return finishJob(db, job, { status: "failed", error: availability.reason, nextRunAt: null });
  const userId = job.requestedBy ?? job.updatedBy;
  if (!userId) return finishJob(db, job, { status: "failed", error: "The member who started this job no longer exists.", nextRunAt: null });
  const accountId = availability.account!.id;

  let companyId: string | null;
  let pages = 0;
  let cursor = job.cursor;
  const people = new Map<string, NonNullable<ReturnType<typeof candidateFromUnipile>>>();
  try {
    companyId = (await knownLinkedinCompanyId(db, job)) ?? (await unipileGetCompany(config, { accountId, identifier: job.companyPublicId })).id;
    if (!companyId) {
      return finishJob(db, job, { status: "failed", error: "LinkedIn's id for this company could not be found.", nextRunAt: null });
    }
    while (people.size < AUTO_BATCH_PEOPLE && pages < AUTO_MAX_PAGES_PER_BATCH) {
      const page = await unipileSearchCompanyPeople(config, { accountId, companyId, limit: AUTO_PAGE_SIZE, cursor });
      pages++;
      for (const item of page.items) {
        const candidate = candidateFromUnipile(item);
        if (candidate && people.size < AUTO_BATCH_PEOPLE) people.set(candidate.publicId, candidate);
      }
      cursor = page.cursor;
      if (!cursor || !page.items.length) break;
    }
  } catch (error) {
    if (error instanceof UnipileError && [401, 403, 404].includes(error.status)) {
      return finishJob(db, job, { status: "failed", error: `LinkedIn refused the request (${error.message}).`, nextRunAt: null });
    }
    const message = error instanceof Error ? error.message : String(error);
    log.warn("automatic capture page failed", { workspaceId: job.workspaceId, companyPublicId: job.companyPublicId, message });
    return finishJob(db, job, retryOrFail(job, `Reading people failed: ${message}`, now));
  }

  if (!people.size) {
    // Nothing on a later page means the company is finished; nothing at all is retried once.
    if (job.batches > 0 && !cursor) {
      return finishJob(db, job, { status: "completed", complete: true, cursor: null, nextRunAt: null, error: null, attempts: 0 });
    }
    return finishJob(db, job, retryOrFail(job, "LinkedIn returned no people for this company.", now));
  }

  try {
    const body = companyIngestSchema.parse({
      publicId: job.companyPublicId,
      sourceUrl: companyCaptureUrl(job.companyPublicId),
      memberId: companyId,
      // Each Unipile page of 50 stands for five LinkedIn result pages of 10.
      pagesRead: Math.min(25, pages * 5),
      peopleProfiles: [...people.values()],
      capturedAt: now.toISOString(),
    });
    const result = await ingestCompanyCapture(db, { workspaceId: job.workspaceId, userId }, body);
    const saved = (result.created ?? 0) + (result.merged ?? 0);
    const done = !cursor;
    await finishJob(db, job, {
      linkedinCompanyId: companyId,
      cursor,
      peopleFound: job.peopleFound + saved,
      pagesRead: job.pagesRead + Math.min(25, pages * 5),
      batches: job.batches + 1,
      attempts: 0,
      error: null,
      status: done ? "completed" : "queued",
      complete: done,
      nextRunAt: done ? null : new Date(now.getTime() + AUTO_BATCH_GAP_MS),
      stopReason: done ? "last results page reached" : null,
    });
  } catch (error) {
    if (error instanceof CaptureError && ["daily_limit_reached", "capture_disabled"].includes(error.code)) {
      // Waits for the user: the people stay unread until the limit resets or capture is back on.
      return finishJob(db, job, { linkedinCompanyId: companyId, status: "paused", error: null, stopReason: error.message, nextRunAt: null });
    }
    const message = error instanceof Error ? error.message : String(error);
    log.warn("automatic capture save failed", { workspaceId: job.workspaceId, companyPublicId: job.companyPublicId, message });
    return finishJob(db, job, retryOrFail(job, `Saving people failed: ${message}`, now));
  }
}

/** One worker pass: claims due automatic jobs and reads one batch of each. Returns how many ran. */
export async function runAutoCapturePass(db: Db, config: Env, now = new Date()): Promise<number> {
  const table = schema.enrichmentCaptureQueue;
  const due = await db
    .select()
    .from(table)
    .where(
      and(
        eq(table.mode, "unipile"),
        or(
          and(eq(table.status, "queued"), or(isNull(table.nextRunAt), lte(table.nextRunAt, now))),
          // A job whose worker died mid-batch.
          and(eq(table.status, "running"), lte(table.updatedAt, new Date(now.getTime() - AUTO_STALE_RUNNING_MS)))
        )
      )
    )
    .orderBy(asc(table.nextRunAt))
    .limit(AUTO_JOBS_PER_PASS);
  let ran = 0;
  for (const candidate of due) {
    // Claim it: only one worker moves a job from the state it was read in.
    const [job] = await db
      .update(table)
      .set({ status: "running", updatedAt: now })
      .where(
        and(
          eq(table.workspaceId, candidate.workspaceId),
          eq(table.companyPublicId, candidate.companyPublicId),
          eq(table.status, candidate.status),
          eq(table.updatedAt, candidate.updatedAt)
        )
      )
      .returning();
    if (!job) continue;
    ran++;
    try {
      await processAutoJob(db, config, job, now);
    } catch (error) {
      log.error("automatic capture job failed", error, { workspaceId: job.workspaceId, companyPublicId: job.companyPublicId });
      await finishJob(db, job, retryOrFail(job, error instanceof Error ? error.message : String(error), now)).catch(() => {});
    }
  }
  return ran;
}
