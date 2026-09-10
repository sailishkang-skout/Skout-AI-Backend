import { Worker, Queue } from "bullmq";
import { resolveScrapeStorage, scrapeKey } from "@skout/storage";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { attachDeadLetterHandler, logRedisMemoryPolicyHint } from "./dlq.js";
import { requireDatabaseUrl } from "./load-env.js";
import { cleanCompaniesAsync } from "./company-cleaner.js";
import { cleanProspects } from "./index.js";

const SCRAPE_QUEUES = { clean: "scrape-clean", ingest: "scrape-ingest", deadLetter: "scrape-dead-letter" };

export async function runCleanPipeline(rawS3Key: string, source: string, jobId: string) {
  const storage = resolveScrapeStorage();
  const rawRecords = await storage.getJsonl(rawS3Key);

  const companies = await cleanCompaniesAsync(rawRecords);
  const prospects = cleanProspects(rawRecords);

  const cleanRecords = [...companies.clean, ...prospects.clean];
  const quarantined = [...companies.quarantined, ...prospects.quarantined];

  const cleanS3Key = scrapeKey("clean", source, jobId);
  await storage.putJsonl(cleanS3Key, cleanRecords);

  if (quarantined.length) {
    await storage.putJsonl(scrapeKey("quarantine", source, jobId), quarantined);
  }

  return { cleanS3Key, cleanCount: cleanRecords.length, quarantinedCount: quarantined.length };
}

export async function startCleanerWorker() {
  const connection = { url: process.env.REDIS_URL ?? "redis://localhost:6379" };
  logRedisMemoryPolicyHint();
  const { db, sql } = createDb(requireDatabaseUrl());
  const ingestQueue = new Queue(SCRAPE_QUEUES.ingest, { connection });
  const deadLetterQueue = new Queue(SCRAPE_QUEUES.deadLetter, { connection });

  const worker = new Worker(
    SCRAPE_QUEUES.clean,
    async (job) => {
      const { jobId, source, rawS3Key } = job.data as {
        jobId: string;
        source: string;
        rawS3Key: string;
      };
      try {
        const result = await runCleanPipeline(rawS3Key, source, jobId);
        await db
          .update(schema.scrapeJobs)
          .set({
            cleanS3Key: result.cleanS3Key,
            cleanCount: result.cleanCount,
            quarantinedCount: result.quarantinedCount,
          })
          .where(eq(schema.scrapeJobs.id, jobId));

        await ingestQueue.add(
          "ingest",
          {
            jobId,
            source,
            cleanS3Key: result.cleanS3Key,
          },
          { attempts: 3, backoff: { type: "exponential", delay: 5_000 } }
        );
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db
          .update(schema.scrapeJobs)
          .set({
            status: "failed",
            errorMessage: message,
            completedAt: new Date(),
          })
          .where(eq(schema.scrapeJobs.id, jobId));
        throw err;
      }
    },
    { connection }
  );
  attachDeadLetterHandler(worker, deadLetterQueue, SCRAPE_QUEUES.clean);

  const shutdown = async () => {
    await worker.close();
    await ingestQueue.close();
    await deadLetterQueue.close();
    await sql.end();
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  console.log("[cleaner] worker started");
  return shutdown;
}

if (process.argv[1]?.includes("worker")) {
  startCleanerWorker().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
