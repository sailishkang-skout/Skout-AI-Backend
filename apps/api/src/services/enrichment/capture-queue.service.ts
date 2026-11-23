/**
 * §5.2 / §7.1 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md. ENR-02 capture queue company list.
 *   - Tables touched directly: companies, contacts (both owned by apps/crm)
 *     - read only (the name of each captured company for the company queue; the people saved
 *       for a company, shown in a capture job's details)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the list joins the CRM company name with the capture identity key (the LinkedIn
 *     company id) and the capture queue progress in one query; same boundary as ENR-03
 *     (research.service.ts) and ENR-02 (capture-ingest.service.ts).
 *   - Review date: revisit once apps/crm's internal API surface fully shipped (Wave 2)
 */
import { and, asc, count as countRows, desc, eq, gte, ilike, inArray, isNull, like, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import { createLogger } from "@skout/observability";
import { normalizeLinkedinId } from "./capture-identity.js";
import { companyPeopleCounts } from "./research.service.js";

/**
 * LinkedIn Enrichment → Capture queue. A company's people discovery is read in reviewed batches
 * of at most 250 people. After each saved batch the extension reports where discovery stands,
 * so companies with result pages left stay listed until someone finishes them or removes them.
 */

const log = createLogger("enrichment.capture-queue");

const companyPublicId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9%._~-]+$/, "Not a LinkedIn company ID.");

const count = z.number().int().nonnegative().max(2_000_000_000);

export const CAPTURE_JOB_STATUSES = ["queued", "running", "review", "paused", "completed", "failed", "skipped", "cancelled"] as const;
export type CaptureJobStatus = (typeof CAPTURE_JOB_STATUSES)[number];
/** Statuses the extension reports; "cancelled" is set only from the workspace. */
const jobStatus = z.enum(["queued", "running", "review", "paused", "completed", "failed", "skipped"]);

/** What a member sees: the stored status, plus "interrupted" and "partial" read from it. */
export const CAPTURE_JOB_STATES = [...CAPTURE_JOB_STATUSES, "interrupted", "partial", "retrying"] as const;
export type CaptureJobState = (typeof CAPTURE_JOB_STATES)[number];

/** A running job that has not reported for this long is shown as interrupted (and recovered, see recoverStaleCaptureJobs). */
export const CAPTURE_JOB_STALE_MS = 20 * 60 * 1000;
/** A job waiting for a person to review a batch may wait much longer than a running one before it is called stuck. */
export const CAPTURE_REVIEW_STALE_MS = 2 * 60 * 60 * 1000;

/** One saved batch (counts) and/or a status change for a company's capture job. */
export const captureQueueUpdateSchema = z
  .object({
    companyName: z.string().trim().max(300).optional(),
    status: jobStatus.optional(),
    error: z.string().trim().max(500).optional(),
    pagesRead: count.optional(),
    peopleFound: count.optional(),
    expectedPeople: count.optional(),
    complete: z.boolean().optional(),
    stopReason: z.string().trim().max(300).optional(),
    /** One saved batch: people it added, matched to people already saved, or refused. */
    created: count.optional(),
    merged: count.optional(),
    rejected: count.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update.");

export type CaptureQueueUpdate = z.infer<typeof captureQueueUpdateSchema>;

/** The extension's whole run queue, reported after every change so the dashboard can follow it. */
export const captureQueueSyncSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            companyPublicId,
            companyName: z.string().trim().max(300).optional(),
            status: jobStatus,
            error: z.string().trim().max(500).optional(),
            /** How many times the extension has retried this company after a recoverable failure. */
            attempts: z.number().int().min(0).max(20).optional(),
          })
          .strict()
      )
      .min(1)
      .max(200),
  })
  .strict();

export type CaptureQueueSync = z.infer<typeof captureQueueSyncSchema>;

export const captureQueueIdSchema = companyPublicId;

export function companyCaptureUrl(publicId: string): string {
  return `https://www.linkedin.com/company/${encodeURIComponent(normalizeLinkedinId(publicId))}/`;
}

type Row = typeof schema.enrichmentCaptureQueue.$inferSelect;

/**
 * The status members see. "interrupted": a job that stopped reporting while running.
 * "partial": a job that saved people but then failed or was cancelled, or finished with records refused.
 */
export function effectiveJobState(
  row: Pick<Row, "status" | "updatedAt"> & Partial<Pick<Row, "peopleFound" | "peopleRejected" | "attempts">>,
  now = Date.now()
): CaptureJobState {
  const age = now - row.updatedAt.getTime();
  if ((row.status === "running" && age > CAPTURE_JOB_STALE_MS) || (row.status === "review" && age > CAPTURE_REVIEW_STALE_MS)) return "interrupted";
  // Queued again after a recoverable failure: the job is being retried, not newly waiting.
  if (row.status === "queued" && (row.attempts ?? 0) > 0) return "retrying";
  if ((row.status === "failed" || row.status === "cancelled") && (row.peopleFound ?? 0) > 0) return "partial";
  if (row.status === "completed" && (row.peopleRejected ?? 0) > 0) return "partial";
  return row.status as CaptureJobStatus;
}

/** SQL for one member-facing state, matching effectiveJobState. */
function stateCondition(state: CaptureJobState): SQL {
  const t = schema.enrichmentCaptureQueue;
  const stale = sql`${t.updatedAt} < now() - interval '20 minutes'`;
  const reviewStale = sql`${t.updatedAt} < now() - interval '2 hours'`;
  switch (state) {
    case "interrupted":
      return sql`((${t.status} = 'running' AND ${stale}) OR (${t.status} = 'review' AND ${reviewStale}))`;
    case "retrying":
      return sql`(${t.status} = 'queued' AND ${t.attempts} > 0)`;
    case "queued":
      return sql`(${t.status} = 'queued' AND ${t.attempts} = 0)`;
    case "partial":
      return sql`((${t.status} IN ('failed', 'cancelled') AND ${t.peopleFound} > 0) OR (${t.status} = 'completed' AND ${t.peopleRejected} > 0))`;
    case "running":
      return sql`(${t.status} = 'running' AND NOT ${stale})`;
    case "review":
      return sql`(${t.status} = 'review' AND NOT ${reviewStale})`;
    case "failed":
    case "cancelled":
      return sql`(${t.status} = ${state} AND ${t.peopleFound} = 0)`;
    case "completed":
      return sql`(${t.status} = 'completed' AND ${t.peopleRejected} = 0)`;
    default:
      return sql`${t.status} = ${state}`;
  }
}

export function captureQueueDto(row: Row, now = Date.now(), startedBy: string | null = null) {
  return {
    companyPublicId: row.companyPublicId,
    companyName: row.companyName,
    sourceUrl: row.sourceUrl,
    pagesRead: row.pagesRead,
    peopleFound: row.peopleFound,
    expectedPeople: row.expectedPeople,
    // How many people LinkedIn says remain; unknown when LinkedIn showed no total.
    remainingPeople: row.expectedPeople == null ? null : Math.max(0, row.expectedPeople - row.peopleFound),
    batches: row.batches,
    /** People the saved batches added, matched to people already saved (duplicates), or refused. */
    peopleCreated: row.peopleCreated,
    peopleMerged: row.peopleMerged,
    peopleRejected: row.peopleRejected,
    complete: row.complete,
    status: row.status,
    state: effectiveJobState(row, now),
    error: row.error,
    /** extension: read in a member's browser | unipile: read automatically on the server. */
    mode: row.mode,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    attempts: row.attempts,
    /** Name (or email) of the member who started or last moved the job. */
    startedBy,
    stopReason: row.stopReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Records a saved batch (counts never go backwards if two batches race) and/or a status change.
 * A batch without an explicit status leaves the job completed when finished, paused otherwise.
 */
export async function recordCaptureQueueBatch(
  db: Db,
  actor: { workspaceId: string; userId: string },
  rawPublicId: string,
  update: CaptureQueueUpdate
) {
  const publicId = normalizeLinkedinId(rawPublicId);
  const table = schema.enrichmentCaptureQueue;
  const now = new Date();
  const savedBatch = update.pagesRead !== undefined && update.peopleFound !== undefined;
  const status: CaptureJobStatus | undefined =
    update.status ?? (update.complete === true ? "completed" : savedBatch ? "paused" : undefined);
  const complete = update.complete ?? (status === "completed" ? true : undefined);
  const [row] = await db
    .insert(table)
    .values({
      workspaceId: actor.workspaceId,
      companyPublicId: publicId,
      companyName: update.companyName || null,
      sourceUrl: companyCaptureUrl(publicId),
      pagesRead: update.pagesRead ?? 0,
      peopleFound: update.peopleFound ?? 0,
      expectedPeople: update.expectedPeople ?? null,
      batches: savedBatch ? 1 : 0,
      peopleCreated: update.created ?? 0,
      peopleMerged: update.merged ?? 0,
      peopleRejected: update.rejected ?? 0,
      complete: complete ?? false,
      status: status ?? "queued",
      error: status === "failed" ? update.error || null : null,
      stopReason: update.stopReason || null,
      updatedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [table.workspaceId, table.companyPublicId],
      set: {
        companyName: sql`COALESCE(${update.companyName || null}, ${table.companyName})`,
        ...(savedBatch
          ? {
              // A finished search restarts from page one next time, so its counts start over too.
              pagesRead: update.complete ? update.pagesRead! : sql`GREATEST(${table.pagesRead}, ${update.pagesRead!})`,
              peopleFound: update.complete ? update.peopleFound! : sql`GREATEST(${table.peopleFound}, ${update.peopleFound!})`,
              batches: sql`${table.batches} + 1`,
            }
          : {}),
        ...(update.created !== undefined ? { peopleCreated: sql`${table.peopleCreated} + ${update.created}` } : {}),
        ...(update.merged !== undefined ? { peopleMerged: sql`${table.peopleMerged} + ${update.merged}` } : {}),
        ...(update.rejected !== undefined ? { peopleRejected: sql`${table.peopleRejected} + ${update.rejected}` } : {}),
        expectedPeople: sql`COALESCE(${update.expectedPeople ?? null}, ${table.expectedPeople})`,
        ...(complete !== undefined ? { complete } : {}),
        // A job cancelled in the workspace stays cancelled when a late report arrives; only starting the
        // company again (queued) is a new job. Its saved people are still counted above.
        ...(status
          ? {
              status: sql`CASE WHEN ${table.status} = 'cancelled' AND ${status} <> 'queued' THEN ${table.status} ELSE ${status} END`,
              error: sql`CASE WHEN ${table.status} = 'cancelled' AND ${status} <> 'queued' THEN ${table.error} ELSE ${status === "failed" ? update.error || null : null} END`,
            }
          : {}),
        // Queued for the extension (from the dashboard or the extension itself): the server worker leaves it alone.
        ...(status === "queued" ? { mode: "extension", nextRunAt: null } : {}),
        stopReason: update.stopReason !== undefined ? update.stopReason || null : table.stopReason,
        updatedBy: actor.userId,
        updatedAt: now,
      },
    })
    .returning();
  if (status === "failed") log.warn("capture job failed", { workspaceId: actor.workspaceId, companyPublicId: publicId, error: update.error ?? null, peopleFound: row!.peopleFound, pagesRead: row!.pagesRead });
  return captureQueueDto(row!);
}

/** Applies the extension's queue states in one request; never touches counts. */
export async function syncCaptureQueue(db: Db, actor: { workspaceId: string; userId: string }, input: CaptureQueueSync) {
  const table = schema.enrichmentCaptureQueue;
  const now = new Date();
  const seen = new Set<string>();
  const items = input.items.filter((item) => {
    const id = normalizeLinkedinId(item.companyPublicId);
    return seen.has(id) ? false : (seen.add(id), true);
  });
  const cancelled: string[] = [];
  await db.transaction(async (tx) => {
    for (const item of items) {
      const publicId = normalizeLinkedinId(item.companyPublicId);
      const [written] = await tx
        .insert(table)
        .values({
          workspaceId: actor.workspaceId,
          companyPublicId: publicId,
          companyName: item.companyName || null,
          sourceUrl: companyCaptureUrl(publicId),
          complete: item.status === "completed",
          status: item.status,
          error: item.status === "failed" ? item.error || null : null,
          attempts: item.attempts ?? 0,
          mode: "extension",
          updatedBy: actor.userId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [table.workspaceId, table.companyPublicId],
          set: {
            companyName: sql`COALESCE(${item.companyName || null}, ${table.companyName})`,
            status: item.status,
            // The extension is reading this company now, so it is an extension job again.
            mode: "extension",
            nextRunAt: null,
            // A job that ends completed is finished; any other state leaves the saved counts alone.
            ...(item.status === "completed" ? { complete: true } : {}),
            error: item.status === "failed" ? item.error || null : null,
            // The extension owns the retry count of its own jobs; a job that is no longer retrying goes back to none.
            attempts: item.attempts ?? 0,
            updatedBy: actor.userId,
            updatedAt: now,
          },
          // A job cancelled in the workspace stays cancelled; the extension is told to drop it.
          // Starting the company again in the extension (queued) is a new job.
          setWhere: sql`${table.status} <> 'cancelled' OR ${item.status} = 'queued'`,
        })
        .returning({ id: table.companyPublicId });
      if (!written) cancelled.push(publicId);
      else if (item.status === "failed") log.warn("capture job failed", { workspaceId: actor.workspaceId, companyPublicId: publicId, error: item.error ?? null });
    }
  });
  return { updated: items.length - cancelled.length, cancelled };
}

/** Cancels a job that has not finished. The extension drops it on its next report; the worker never reads it. */
export async function cancelCaptureJob(db: Db, actor: { workspaceId: string; userId: string }, rawPublicId: string) {
  const table = schema.enrichmentCaptureQueue;
  const [row] = await db
    .update(table)
    .set({ status: "cancelled", nextRunAt: null, error: null, updatedBy: actor.userId, updatedAt: new Date() })
    .where(
      and(
        eq(table.workspaceId, actor.workspaceId),
        eq(table.companyPublicId, normalizeLinkedinId(rawPublicId)),
        sql`${table.status} NOT IN ('completed', 'cancelled')`
      )
    )
    .returning();
  return row ? captureQueueDto(row) : null;
}

/**
 * Stuck jobs. A job read in a browser that has stopped reporting (the browser closed, the extension
 * restarted, the network dropped for good) would otherwise sit as "running" for ever. It is moved to
 * "paused" with the reason, keeping its saved counts, so it can be resumed (the extension, or the workspace's
 * Resume, queues it again) and is never counted as running. A job waiting for a person to review a batch is
 * given much longer. Server-read (automatic) jobs have their own recovery in runAutoCapturePass.
 */
export async function recoverStaleCaptureJobs(db: Db, now = new Date()): Promise<number> {
  const table = schema.enrichmentCaptureQueue;
  const runningBefore = new Date(now.getTime() - CAPTURE_JOB_STALE_MS);
  const reviewBefore = new Date(now.getTime() - CAPTURE_REVIEW_STALE_MS);
  const recovered = await db
    .update(table)
    .set({
      status: "paused",
      nextRunAt: null,
      stopReason: sql`'The extension stopped reporting while this job was ' || ${table.status} || '. Resume it to continue where it stopped.'`,
      updatedAt: now,
    })
    .where(
      and(
        eq(table.mode, "extension"),
        or(and(eq(table.status, "running"), lte(table.updatedAt, runningBefore)), and(eq(table.status, "review"), lte(table.updatedAt, reviewBefore)))
      )
    )
    .returning({ workspaceId: table.workspaceId, companyPublicId: table.companyPublicId });
  for (const job of recovered) log.warn("stuck capture job paused", { workspaceId: job.workspaceId, companyPublicId: job.companyPublicId });
  return recovered.length;
}

export interface CaptureQueueFilters {
  status?: CaptureJobStatus;
  state?: CaptureJobState;
  mode?: "extension" | "unipile";
  q?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

export const captureQueueListSchema = z.object({
  status: z.enum(CAPTURE_JOB_STATUSES).optional(),
  state: z.enum(CAPTURE_JOB_STATES).optional(),
  mode: z.enum(["extension", "unipile"]).optional(),
  q: z.string().trim().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(200),
});

/** Capture jobs of every member of the workspace, newest activity first, with dashboard totals. */
export async function listCaptureQueue(db: Db, workspaceId: string, opts: CaptureQueueFilters = {}) {
  const table = schema.enrichmentCaptureQueue;
  const users = schema.users;
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 200;
  const term = opts.q?.trim();
  const where = and(
    eq(table.workspaceId, workspaceId),
    ...(opts.status ? [eq(table.status, opts.status)] : []),
    ...(opts.state ? [stateCondition(opts.state)] : []),
    ...(opts.mode ? [eq(table.mode, opts.mode)] : []),
    ...(term
      ? [sql`(${table.companyName} ILIKE ${`%${term.replace(/[\\%_]/g, "\\$&")}%`} OR ${table.companyPublicId} ILIKE ${`%${term.replace(/[\\%_]/g, "\\$&")}%`})`]
      : []),
    ...(opts.from ? [gte(table.createdAt, opts.from)] : []),
    ...(opts.to ? [lte(table.createdAt, opts.to)] : [])
  );
  const [rows, [totals]] = await Promise.all([
    db
      .select({ job: table, name: users.fullName, email: users.email })
      .from(table)
      .leftJoin(users, eq(users.id, sql`COALESCE(${table.requestedBy}, ${table.updatedBy})`))
      .where(where)
      .orderBy(desc(table.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: countRows() }).from(table).where(where),
  ]);
  const now = Date.now();
  return {
    items: rows.map((row) => captureQueueDto(row.job, now, row.name || row.email || null)),
    total: Number(totals?.total ?? 0),
    page,
    pageSize,
    stats: await captureQueueStats(db, workspaceId),
  };
}

/** Dashboard totals across the workspace's jobs (unfiltered), and jobs created per day for 7 days. */
export async function captureQueueStats(db: Db, workspaceId: string) {
  const t = schema.enrichmentCaptureQueue;
  const n = (condition: SQL) => sql<number>`count(*) filter (where ${condition})::int`;
  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      running: n(sql`${stateCondition("queued")} OR ${stateCondition("retrying")} OR ${stateCondition("running")} OR ${stateCondition("review")}`),
      completed: n(sql`${t.status} = 'completed'`),
      failed: n(sql`${t.status} = 'failed' OR ${stateCondition("interrupted")}`),
      paused: n(sql`${t.status} = 'paused'`),
      peopleCaptured: sql<number>`coalesce(sum(${t.peopleFound}), 0)::int`,
    })
    .from(t)
    .where(eq(t.workspaceId, workspaceId));
  const days = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${t.createdAt}), 'YYYY-MM-DD')`,
      created: sql<number>`count(*)::int`,
      completed: n(sql`${t.status} = 'completed'`),
      failed: n(sql`${t.status} = 'failed'`),
    })
    .from(t)
    .where(and(eq(t.workspaceId, workspaceId), gte(t.createdAt, sql`now() - interval '7 days'`)))
    .groupBy(sql`date_trunc('day', ${t.createdAt})`)
    .orderBy(sql`date_trunc('day', ${t.createdAt})`);
  return {
    total: Number(totals?.total ?? 0),
    running: Number(totals?.running ?? 0),
    completed: Number(totals?.completed ?? 0),
    failed: Number(totals?.failed ?? 0),
    paused: Number(totals?.paused ?? 0),
    peopleCaptured: Number(totals?.peopleCaptured ?? 0),
    daily: days.map((d) => ({ day: d.day, created: Number(d.created), completed: Number(d.completed), failed: Number(d.failed) })),
  };
}

/**
 * One job for the details drawer: the job, its saved batches (capture runs of that company page:
 * people added, duplicates, refused, and error messages), and the people saved for the company.
 */
export async function captureJobDetails(db: Db, workspaceId: string, rawPublicId: string) {
  const publicId = normalizeLinkedinId(rawPublicId);
  const table = schema.enrichmentCaptureQueue;
  const users = schema.users;
  const [found] = await db
    .select({ job: table, name: users.fullName, email: users.email })
    .from(table)
    .leftJoin(users, eq(users.id, sql`COALESCE(${table.requestedBy}, ${table.updatedBy})`))
    .where(and(eq(table.workspaceId, workspaceId), eq(table.companyPublicId, publicId)))
    .limit(1);
  if (!found) return null;
  const runs = schema.enrichmentCaptureRuns;
  const companyUrl = companyCaptureUrl(publicId);
  const batches = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.workspaceId, workspaceId),
        eq(runs.kind, "company"),
        sql`${runs.sourceUrl} LIKE ${`${companyUrl.replace(/[\\%_]/g, "\\$&")}%`}`
      )
    )
    .orderBy(desc(runs.startedAt))
    .limit(25);
  // People saved for this company: verified employees and discovery candidates.
  const i = schema.enrichmentIdentities;
  const [company] = await db
    .select({ id: i.entityId })
    .from(i)
    .where(and(eq(i.workspaceId, workspaceId), eq(i.entityType, "company"), eq(i.canonicalKey, `company:${publicId}`)))
    .limit(1);
  const contacts = schema.contacts;
  const discoveries = schema.companyPersonDiscoveries;
  // Verified employees and discovery candidates of the company, newest first, each once.
  const ofCompany = company
    ? and(
        eq(contacts.workspaceId, workspaceId),
        isNull(contacts.deletedAt),
        or(
          eq(contacts.companyId, company.id),
          inArray(
            contacts.id,
            db.select({ id: discoveries.contactId }).from(discoveries).where(and(eq(discoveries.workspaceId, workspaceId), eq(discoveries.companyId, company.id)))
          )
        )
      )
    : undefined;
  const people = ofCompany
    ? await db
        .select({
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          title: contacts.title,
          linkedinUrl: contacts.linkedinUrl,
          employmentStatus: contacts.employmentStatus,
          savedAt: contacts.createdAt,
        })
        .from(contacts)
        .where(ofCompany)
        .orderBy(desc(contacts.createdAt), contacts.id)
        .limit(50)
    : [];
  const [peopleTotal] = ofCompany ? await db.select({ total: countRows() }).from(contacts).where(ofCompany) : [{ total: 0 }];
  return {
    item: captureQueueDto(found.job, Date.now(), found.name || found.email || null),
    batches: batches.map((run) => ({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      pagesRead: run.pagesRead,
      received: run.leadsReceived,
      created: run.leadsCreated,
      merged: run.leadsMerged,
      rejected: run.leadsRejected,
      error: run.errorMessage,
    })),
    peopleTotal: Number(peopleTotal?.total ?? 0),
    people: people.map((person) => ({
      id: person.id,
      name: [person.firstName, person.lastName].filter(Boolean).join(" ") || null,
      title: person.title,
      linkedinUrl: person.linkedinUrl,
      verified: person.employmentStatus === "verified_employment",
      savedAt: person.savedAt.toISOString(),
    })),
  };
}

/**
 * Asks for a job to be read again (resume a paused or interrupted one, retry a failed one).
 * The extension picks queued jobs up from its side panel, where the user starts them.
 */
export async function requestCaptureResume(db: Db, actor: { workspaceId: string; userId: string }, rawPublicId: string) {
  const table = schema.enrichmentCaptureQueue;
  const [row] = await db
    .update(table)
    .set({
      status: "queued",
      error: null,
      attempts: 0,
      // An automatic job is picked up by the worker on its next pass.
      nextRunAt: sql`CASE WHEN ${table.mode} = 'unipile' THEN now() ELSE ${table.nextRunAt} END`,
      requestedBy: sql`CASE WHEN ${table.mode} = 'unipile' THEN ${actor.userId}::uuid ELSE ${table.requestedBy} END`,
      updatedBy: actor.userId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(table.workspaceId, actor.workspaceId),
        eq(table.companyPublicId, normalizeLinkedinId(rawPublicId)),
        // A job actively running is not restarted; an interrupted one (stale) can be.
        or(
          sql`${table.status} NOT IN ('running', 'review')`,
          sql`${table.updatedAt} < now() - interval '20 minutes'`
        )
      )
    )
    .returning();
  return row ? captureQueueDto(row) : null;
}

export async function removeFromCaptureQueue(db: Db, workspaceId: string, rawPublicId: string) {
  const table = schema.enrichmentCaptureQueue;
  const removed = await db
    .delete(table)
    .where(and(eq(table.workspaceId, workspaceId), eq(table.companyPublicId, normalizeLinkedinId(rawPublicId))))
    .returning({ id: table.companyPublicId });
  return removed.length > 0;
}

/**
 * Companies captured in this workspace that the extension can read the people of, with how far
 * each one got. The LinkedIn company id is the canonical `company:<id>` identity key.
 */
export async function listCapturableCompanies(db: Db, workspaceId: string, search?: string) {
  const c = schema.companies;
  const i = schema.enrichmentIdentities;
  const q = schema.enrichmentCaptureQueue;
  const term = search?.trim();
  const rows = await db
    .select({
      id: c.id,
      name: c.name,
      key: i.canonicalKey,
      peopleFound: q.peopleFound,
      expectedPeople: q.expectedPeople,
      batches: q.batches,
      complete: q.complete,
      status: q.status,
      mode: q.mode,
      updatedAt: q.updatedAt,
    })
    .from(c)
    .innerJoin(
      i,
      and(eq(i.workspaceId, c.workspaceId), eq(i.entityId, c.id), eq(i.entityType, "company"), like(i.canonicalKey, "company:%"))
    )
    .leftJoin(q, and(eq(q.workspaceId, c.workspaceId), eq(q.companyPublicId, sql`substr(${i.canonicalKey}, 9)`)))
    .where(
      and(
        eq(c.workspaceId, workspaceId),
        isNull(c.deletedAt),
        ...(term ? [ilike(c.name, `%${term.replace(/[\\%_]/g, "\\$&")}%`)] : [])
      )
    )
    .orderBy(asc(c.name), asc(c.id))
    .limit(1000);
  const seen = new Set<string>();
  const unique = rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
  // People already in the workspace for each company, however they were captured.
  const counts = await companyPeopleCounts(db, workspaceId, unique.map((row) => row.id));
  return unique
    .map((row) => ({
      companyPublicId: row.key.slice("company:".length),
      name: row.name,
      peopleFound: row.peopleFound ?? 0,
      expectedPeople: row.expectedPeople,
      batches: row.batches ?? 0,
      // null: never captured through the queue, so nothing is known about what remains.
      complete: row.complete,
      status: row.status,
      mode: row.mode ?? null,
      peopleSaved: (counts.get(row.id)?.verified ?? 0) + (counts.get(row.id)?.candidates ?? 0),
      updatedAt: row.updatedAt?.toISOString() ?? null,
    }));
}
