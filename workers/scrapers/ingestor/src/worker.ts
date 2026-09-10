import { Worker, Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { attachDeadLetterHandler, logRedisMemoryPolicyHint } from "./dlq.js";
import { requireDatabaseUrl } from "./load-env.js";
import {
  bulkUpsertProspects,
  ensureProspectsIndex,
  type OpenSearchConfig,
} from "@skout/opensearch";
import { scrapeJobManifestSchema } from "@skout/scraper-contracts";
import { resolveScrapeStorage, scrapeKey } from "@skout/storage";
import { recordsToDocs } from "./index.js";
import { enrichDocsWithGrowth } from "./growth.js";
import type { Db } from "@skout/db";

const SCRAPE_QUEUES = { ingest: "scrape-ingest", deadLetter: "scrape-dead-letter" };

function osConfig(): OpenSearchConfig {
  const url = process.env.OPENSEARCH_URL;
  if (!url) throw new Error("OPENSEARCH_URL required for ingestor");
  return {
    url,
    username: process.env.OPENSEARCH_USERNAME,
    password: process.env.OPENSEARCH_PASSWORD,
    index: process.env.OPENSEARCH_INDEX,
  };
}

export async function runIngestPipeline(cleanS3Key: string, source: string, jobId: string, db?: Db) {
  const storage = resolveScrapeStorage();
  const records = await storage.getJsonl(cleanS3Key);
  let docs = recordsToDocs(records);

  if (db) {
    docs = await enrichDocsWithGrowth(db, records, docs);
  }

  const cfg = osConfig();
  await ensureProspectsIndex(cfg);
  const { ingested, failed } = await bulkUpsertProspects(cfg, docs);

  const manifest = scrapeJobManifestSchema.parse({
    jobId,
    source,
    status: failed > 0 ? "failed" : "completed",
    counts: {
      raw: 0,
      clean: records.length,
      quarantined: 0,
      ingested,
      skippedDuplicate: 0,
    },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });

  const manifestS3Key = scrapeKey("manifests", source, jobId);
  await storage.putJson(manifestS3Key, manifest);

  return { manifestS3Key, ingested, failed, skippedDuplicate: 0 };
}

export async function startIngestorWorker() {
  const connection = { url: process.env.REDIS_URL ?? "redis://localhost:6379" };
  logRedisMemoryPolicyHint();
  const { db, sql } = createDb(requireDatabaseUrl());
  const deadLetterQueue = new Queue(SCRAPE_QUEUES.deadLetter, { connection });

  const worker = new Worker(
    SCRAPE_QUEUES.ingest,
    async (job) => {
      const { jobId, source, cleanS3Key } = job.data as {
        jobId: string;
        source: string;
        cleanS3Key: string;
      };
      try {
        const result = await runIngestPipeline(cleanS3Key, source, jobId, db);
        await db
          .update(schema.scrapeJobs)
          .set({
            manifestS3Key: result.manifestS3Key,
            ingestedCount: result.ingested,
            skippedDuplicateCount: result.skippedDuplicate,
            status: result.failed > 0 ? "failed" : "completed",
            completedAt: new Date(),
          })
          .where(eq(schema.scrapeJobs.id, jobId));
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
  attachDeadLetterHandler(worker, deadLetterQueue, SCRAPE_QUEUES.ingest);

  const shutdown = async () => {
    await worker.close();
    await deadLetterQueue.close();
    await sql.end();
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  console.log("[ingestor] worker started");
  return shutdown;
}

if (process.argv[1]?.includes("worker")) {
  startIngestorWorker().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
