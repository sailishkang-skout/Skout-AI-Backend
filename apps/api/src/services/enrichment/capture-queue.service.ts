import { and, asc, eq, ilike, isNull, like, sql } from "drizzle-orm";
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

export const captureQueueUpdateSchema = z
  .object({
    companyName: z.string().trim().max(300).optional(),
    pagesRead: count,
    peopleFound: count,
    expectedPeople: count.optional(),
    complete: z.boolean(),
    stopReason: z.string().trim().max(300).optional(),
  })
  .strict();

export type CaptureQueueUpdate = z.infer<typeof captureQueueUpdateSchema>;

export const captureQueueIdSchema = companyPublicId;

export function companyCaptureUrl(publicId: string): string {
  return `https://www.linkedin.com/company/${encodeURIComponent(normalizeLinkedinId(publicId))}/`;
}

type Row = typeof schema.enrichmentCaptureQueue.$inferSelect;

export function captureQueueDto(row: Row) {
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
    stopReason: row.stopReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Records one saved batch. Counts never go backwards if two batches race. */
export async function recordCaptureQueueBatch(
  db: Db,
  actor: { workspaceId: string; userId: string },
  rawPublicId: string,
  update: CaptureQueueUpdate
) {
  const publicId = normalizeLinkedinId(rawPublicId);
  const table = schema.enrichmentCaptureQueue;
  const now = new Date();
  const [row] = await db
    .insert(table)
    .values({
      workspaceId: actor.workspaceId,
      companyPublicId: publicId,
      companyName: update.companyName || null,
      sourceUrl: companyCaptureUrl(publicId),
      pagesRead: update.pagesRead,
      peopleFound: update.peopleFound,
      expectedPeople: update.expectedPeople ?? null,
      batches: 1,
      complete: update.complete,
      stopReason: update.stopReason || null,
      updatedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [table.workspaceId, table.companyPublicId],
      set: {
        companyName: sql`COALESCE(${update.companyName || null}, ${table.companyName})`,
        // A finished search restarts from page one next time, so its counts start over too.
        pagesRead: update.complete ? update.pagesRead : sql`GREATEST(${table.pagesRead}, ${update.pagesRead})`,
        peopleFound: update.complete ? update.peopleFound : sql`GREATEST(${table.peopleFound}, ${update.peopleFound})`,
        expectedPeople: sql`COALESCE(${update.expectedPeople ?? null}, ${table.expectedPeople})`,
        batches: sql`${table.batches} + 1`,
        complete: update.complete,
        stopReason: update.stopReason || null,
        updatedBy: actor.userId,
        updatedAt: now,
      },
    })
    .returning();
  return captureQueueDto(row!);
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
      updatedAt: row.updatedAt?.toISOString() ?? null,
    }));
}
