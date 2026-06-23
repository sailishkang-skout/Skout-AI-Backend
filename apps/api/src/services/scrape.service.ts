import { desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { ScrapeJobRequest } from "@skout/scraper-contracts";
import { enqueueScrapeJob } from "@skout/scraper-orchestrator";
import type { Env } from "../config/env.js";
import { isRedisAvailable } from "../lib/redis.js";

const { scrapeJobs } = schema;

function serializeJob(row: typeof scrapeJobs.$inferSelect) {
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    trigger: row.trigger,
    seeds: row.seeds ?? [],
    rawCount: row.rawCount,
    cleanCount: row.cleanCount,
    quarantinedCount: row.quarantinedCount,
    ingestedCount: row.ingestedCount,
    skippedDuplicateCount: row.skippedDuplicateCount,
    rawS3Key: row.rawS3Key,
    cleanS3Key: row.cleanS3Key,
    errorMessage: row.errorMessage,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export async function createAndEnqueueScrapeJob(db: Db, config: Env, request: ScrapeJobRequest) {
  const [row] = await db
    .insert(scrapeJobs)
    .values({
      source: request.source,
      status: "queued",
      trigger: "api",
      seeds: request.seeds,
      options: request.options ?? {},
    })
    .returning();

  const redisUp = await isRedisAvailable(config);
  if (!redisUp) {
    await db
      .update(scrapeJobs)
      .set({
        status: "failed",
        errorMessage: "Redis unavailable — start with: docker compose up -d redis",
        completedAt: new Date(),
      })
      .where(eq(scrapeJobs.id, row.id));
    return {
      job: serializeJob({
        ...row,
        status: "failed",
        errorMessage: "Redis unavailable — start with: docker compose up -d redis",
        completedAt: new Date(),
      }),
      warning: "Redis unavailable — job saved but not enqueued. Run: docker compose up -d redis",
    };
  }

  try {
    await enqueueScrapeJob(request, { scrapeJobId: row.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "queue_unavailable";
    await db
      .update(scrapeJobs)
      .set({
        status: "failed",
        errorMessage: message,
        completedAt: new Date(),
      })
      .where(eq(scrapeJobs.id, row.id));
    throw err;
  }

  return { job: serializeJob(row) };
}

export async function listScrapeJobs(db: Db, limit = 50) {
  const rows = await db
    .select()
    .from(scrapeJobs)
    .orderBy(desc(scrapeJobs.queuedAt))
    .limit(limit);
  return rows.map(serializeJob);
}

export async function getScrapeJob(db: Db, jobId: string) {
  const [row] = await db.select().from(scrapeJobs).where(eq(scrapeJobs.id, jobId)).limit(1);
  return row ? serializeJob(row) : null;
}
