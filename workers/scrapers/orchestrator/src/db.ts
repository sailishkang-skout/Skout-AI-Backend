import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";

const { scrapeJobs } = schema;

export function openDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required for scrape orchestrator");
  return createDb(url);
}

export async function createScrapeJob(
  db: ReturnType<typeof createDb>["db"],
  input: { source: string; seeds: string[]; trigger?: string; options?: Record<string, unknown> }
) {
  const [row] = await db
    .insert(scrapeJobs)
    .values({
      source: input.source,
      status: "queued",
      trigger: input.trigger ?? "schedule",
      seeds: input.seeds,
      options: input.options ?? {},
    })
    .returning();
  return row;
}

export async function patchScrapeJob(
  db: ReturnType<typeof createDb>["db"],
  jobId: string,
  patch: Partial<{
    status: string;
    rawS3Key: string;
    cleanS3Key: string;
    manifestS3Key: string;
    rawCount: number;
    cleanCount: number;
    quarantinedCount: number;
    ingestedCount: number;
    skippedDuplicateCount: number;
    errorMessage: string | null;
    startedAt: Date;
    completedAt: Date;
  }>
) {
  await db.update(scrapeJobs).set(patch).where(eq(scrapeJobs.id, jobId));
}
