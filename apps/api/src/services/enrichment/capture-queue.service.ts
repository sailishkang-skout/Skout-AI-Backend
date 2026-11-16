/**
 * §5.2 / §7.1 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md. ENR-02 capture queue company list.
 *   - Tables touched directly: companies (owned by apps/crm)
 *     - read only (name of each captured company, to list it in the extension's company queue)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the list joins the CRM company name with the capture identity key (the LinkedIn
 *     company id) and the capture queue progress in one query; same boundary as ENR-03
 *     (research.service.ts) and ENR-02 (capture-ingest.service.ts).
 *   - Review date: revisit once apps/crm's internal API surface fully shipped (Wave 2)
 */
import { and, asc, desc, eq, ilike, isNull, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import { normalizeLinkedinId } from "./capture-identity.js";

/**
 * LinkedIn Enrichment → Capture queue. A company's people discovery is read in reviewed batches
 * of at most 250 people. After each saved batch the extension reports where discovery stands,
 * so companies with result pages left stay listed until someone finishes them or removes them.
 */

const companyPublicId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9%._~-]+$/, "Not a LinkedIn company ID.");

const count = z.number().int().nonnegative().max(2_000_000_000);

export const CAPTURE_JOB_STATUSES = ["queued", "running", "review", "paused", "completed", "failed", "skipped"] as const;
export type CaptureJobStatus = (typeof CAPTURE_JOB_STATUSES)[number];
const jobStatus = z.enum(CAPTURE_JOB_STATUSES);

/** A running or in-review job that has not reported for this long is shown as interrupted. */
export const CAPTURE_JOB_STALE_MS = 20 * 60 * 1000;

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

/** The status users see: a job that stopped reporting while running is "interrupted". */
export function effectiveJobState(row: Pick<Row, "status" | "updatedAt">, now = Date.now()): CaptureJobStatus | "interrupted" {
  const stale = now - row.updatedAt.getTime() > CAPTURE_JOB_STALE_MS;
  return stale && (row.status === "running" || row.status === "review") ? "interrupted" : (row.status as CaptureJobStatus);
}

export function captureQueueDto(row: Row, now = Date.now()) {
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
    complete: row.complete,
    status: row.status,
    state: effectiveJobState(row, now),
    error: row.error,
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
        expectedPeople: sql`COALESCE(${update.expectedPeople ?? null}, ${table.expectedPeople})`,
        ...(complete !== undefined ? { complete } : {}),
        ...(status ? { status, error: status === "failed" ? update.error || null : null } : {}),
        stopReason: update.stopReason !== undefined ? update.stopReason || null : table.stopReason,
        updatedBy: actor.userId,
        updatedAt: now,
      },
    })
    .returning();
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
  await db.transaction(async (tx) => {
    for (const item of items) {
      const publicId = normalizeLinkedinId(item.companyPublicId);
      await tx
        .insert(table)
        .values({
          workspaceId: actor.workspaceId,
          companyPublicId: publicId,
          companyName: item.companyName || null,
          sourceUrl: companyCaptureUrl(publicId),
          complete: item.status === "completed",
          status: item.status,
          error: item.status === "failed" ? item.error || null : null,
          updatedBy: actor.userId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [table.workspaceId, table.companyPublicId],
          set: {
            companyName: sql`COALESCE(${item.companyName || null}, ${table.companyName})`,
            status: item.status,
            // A job that ends completed is finished; any other state leaves the saved counts alone.
            ...(item.status === "completed" ? { complete: true } : {}),
            error: item.status === "failed" ? item.error || null : null,
            updatedBy: actor.userId,
            updatedAt: now,
          },
        });
    }
  });
  return { updated: items.length };
}

/** Capture jobs for the dashboard, newest activity first. */
export async function listCaptureQueue(db: Db, workspaceId: string, opts: { status?: CaptureJobStatus } = {}) {
  const table = schema.enrichmentCaptureQueue;
  const rows = await db
    .select()
    .from(table)
    .where(opts.status ? and(eq(table.workspaceId, workspaceId), eq(table.status, opts.status)) : eq(table.workspaceId, workspaceId))
    .orderBy(desc(table.updatedAt))
    .limit(500);
  const now = Date.now();
  return rows.map((row) => captureQueueDto(row, now));
}

/**
 * Asks for a job to be read again (resume a paused or interrupted one, retry a failed one).
 * The extension picks queued jobs up from its side panel, where the user starts them.
 */
export async function requestCaptureResume(db: Db, actor: { workspaceId: string; userId: string }, rawPublicId: string) {
  const table = schema.enrichmentCaptureQueue;
  const [row] = await db
    .update(table)
    .set({ status: "queued", error: null, updatedBy: actor.userId, updatedAt: new Date() })
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
  return rows
    .filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)))
    .map((row) => ({
      companyPublicId: row.key.slice("company:".length),
      name: row.name,
      peopleFound: row.peopleFound ?? 0,
      expectedPeople: row.expectedPeople,
      batches: row.batches ?? 0,
      // null: never captured through the queue, so nothing is known about what remains.
      complete: row.complete,
      status: row.status,
      updatedAt: row.updatedAt?.toISOString() ?? null,
    }));
}
