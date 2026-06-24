import { Queue, Worker } from "bullmq";
import { scrapeJobRequestSchema } from "@skout/scraper-contracts";
import { createScrapeStorage, resolveScrapeStorage, scrapeKey } from "@skout/storage";
import { scrapeCompanyWeb } from "./bots/company-web.js";
import { scrapeLinkedIn } from "./bots/linkedin.js";
import { scrapeOpenCorporates } from "./bots/opencorporates.js";
import { scrapeSecEdgar } from "./bots/sec-edgar.js";
import { createScrapeJob, openDb, patchScrapeJob } from "./db.js";
import {
  queueForSource,
  SCRAPE_QUEUES,
  SCRAPE_JOB_OPTS,
  type CleanJobPayload,
  type ScrapeJobPayload,
} from "./queues.js";

function redisConnection() {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return { url };
}

function scrapeStorage() {
  if (process.env.SCRAPE_BUCKET) {
    return createScrapeStorage(process.env.SCRAPE_BUCKET);
  }
  return resolveScrapeStorage();
}

async function runBot(payload: ScrapeJobPayload): Promise<{ rawS3Key: string; rawCount: number }> {
  const storage = scrapeStorage();
  const { jobId, source, seeds } = payload;
  const records = [];

  for (const seed of seeds) {
    if (source === "company-web") {
      records.push(await scrapeCompanyWeb(jobId, seed));
    } else if (source === "opencorporates") {
      records.push(...(await scrapeOpenCorporates(jobId, seed)));
    } else if (source === "sec-edgar") {
      records.push(...(await scrapeSecEdgar(jobId, seed)));
    } else if (source === "linkedin") {
      records.push(...(await scrapeLinkedIn(jobId, seed)));
    } else {
      throw new Error(`Unsupported bot source: ${source}`);
    }
  }

  const rawS3Key = scrapeKey("raw", source, jobId);
  await storage.putJsonl(rawS3Key, records);
  return { rawS3Key, rawCount: records.length };
}

/** Start all BullMQ workers for the corpus pipeline. */
export async function startOrchestratorWorkers() {
  const connection = redisConnection();
  const { db, sql } = openDb();

  const cleanQueue = new Queue(SCRAPE_QUEUES.clean, { connection });

  // 1. Schedule: validate request → scrape_jobs row → fan-out to bot queue
  const scheduleWorker = new Worker(
    SCRAPE_QUEUES.schedule,
    async (job) => {
      const request = scrapeJobRequestSchema.parse(job.data);
      const scrapeJobId =
        typeof job.data === "object" &&
        job.data !== null &&
        "scrapeJobId" in job.data &&
        typeof (job.data as { scrapeJobId?: string }).scrapeJobId === "string" &&
        (job.data as { scrapeJobId?: string }).scrapeJobId
          ? (job.data as { scrapeJobId: string }).scrapeJobId
          : "";
      const row = scrapeJobId
        ? { id: scrapeJobId }
        : await createScrapeJob(db, {
            source: request.source,
            seeds: request.seeds,
            trigger: "api",
            options: request.options ?? {},
          });
      const botQueue = new Queue(queueForSource(request.source), { connection });
      await botQueue.add("scrape", {
        jobId: row.id,
        source: request.source,
        seeds: request.seeds,
        options: request.options,
      } satisfies ScrapeJobPayload, SCRAPE_JOB_OPTS);
      return { jobId: row.id };
    },
    { connection }
  );

  // 2. Bot workers (one per source)
  const botHandler = async (payload: ScrapeJobPayload) => {
    await patchScrapeJob(db, payload.jobId, { status: "running", startedAt: new Date() });
    try {
      const { rawS3Key, rawCount } = await runBot(payload);
      await patchScrapeJob(db, payload.jobId, { rawS3Key, rawCount });
      await cleanQueue.add("clean", {
        jobId: payload.jobId,
        source: payload.source,
        rawS3Key,
      } satisfies CleanJobPayload, SCRAPE_JOB_OPTS);
      return { rawS3Key, rawCount };
    } catch (err) {
      await patchScrapeJob(db, payload.jobId, {
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      });
      throw err;
    }
  };

  const botWorkers = [
    new Worker(SCRAPE_QUEUES.companyWeb, (j) => botHandler(j.data as ScrapeJobPayload), { connection }),
    new Worker(SCRAPE_QUEUES.opencorporates, (j) => botHandler(j.data as ScrapeJobPayload), { connection }),
    new Worker(SCRAPE_QUEUES.secEdgar, (j) => botHandler(j.data as ScrapeJobPayload), { connection }),
    new Worker(SCRAPE_QUEUES.linkedin, (j) => botHandler(j.data as ScrapeJobPayload), { connection }),
  ];

  const shutdown = async () => {
    await scheduleWorker.close();
    await Promise.all(botWorkers.map((w) => w.close()));
    await cleanQueue.close();
    await sql.end();
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  console.log("[orchestrator] workers started");
  return shutdown;
}

// CLI entry
if (process.argv[1]?.includes("worker")) {
  startOrchestratorWorkers().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
