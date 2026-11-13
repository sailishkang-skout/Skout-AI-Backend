import { and, desc, eq, sql } from "drizzle-orm";
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

export async function listCaptureQueue(db: Db, workspaceId: string, opts: { includeComplete?: boolean } = {}) {
  const table = schema.enrichmentCaptureQueue;
  const rows = await db
    .select()
    .from(table)
    .where(opts.includeComplete ? eq(table.workspaceId, workspaceId) : and(eq(table.workspaceId, workspaceId), eq(table.complete, false)))
    .orderBy(table.complete, desc(table.updatedAt))
    .limit(500);
  return rows.map(captureQueueDto);
}

export async function removeFromCaptureQueue(db: Db, workspaceId: string, rawPublicId: string) {
  const table = schema.enrichmentCaptureQueue;
  const removed = await db
    .delete(table)
    .where(and(eq(table.workspaceId, workspaceId), eq(table.companyPublicId, normalizeLinkedinId(rawPublicId))))
    .returning({ id: table.companyPublicId });
  return removed.length > 0;
}
