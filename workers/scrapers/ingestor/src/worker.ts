import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import {
  bulkUpsertProspects,
  ensureProspectsIndex,
  type OpenSearchConfig,
} from "@skout/opensearch";
import { scrapeJobManifestSchema } from "@skout/scraper-contracts";
import { createScrapeStorage, scrapeKey } from "@skout/storage";
import { recordsToDocs } from "./index.js";

const SCRAPE_QUEUES = { ingest: "scrape:ingest" };

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

export async function runIngestPipeline(cleanS3Key: string, source: string, jobId: string) {
  const bucket = process.env.SCRAPE_BUCKET;
  if (!bucket) throw new Error("SCRAPE_BUCKET required");
  const storage = createScrapeStorage(bucket);
  const records = await storage.getJsonl(cleanS3Key);
  const docs = recordsToDocs(records);

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
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const { db, sql } = createDb(url);

  const worker = new Worker(
    SCRAPE_QUEUES.ingest,
    async (job) => {
      const { jobId, source, cleanS3Key } = job.data as {
        jobId: string;
        source: string;
        cleanS3Key: string;
      };
      const result = await runIngestPipeline(cleanS3Key, source, jobId);
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
    },
    { connection }
  );

  const shutdown = async () => {
    await worker.close();
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
