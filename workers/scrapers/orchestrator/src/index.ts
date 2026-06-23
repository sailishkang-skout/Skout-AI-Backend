import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import {
  scrapeJobRequestSchema,
  type ScrapeJobManifest,
  type ScrapeJobRequest,
} from "@skout/scraper-contracts";
import { queueForSource, SCRAPE_QUEUES } from "./queues.js";

export { SCRAPE_QUEUES, queueForSource } from "./queues.js";
export { startOrchestratorWorkers } from "./worker.js";

/** Enqueue a scrape job via BullMQ (returns immediately with queued manifest). */
export async function enqueueScrapeJob(
  input: unknown,
  options?: { scrapeJobId?: string }
): Promise<ScrapeJobManifest> {
  const request: ScrapeJobRequest = scrapeJobRequestSchema.parse(input);
  const jobId = options?.scrapeJobId ?? randomUUID();
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const queue = new Queue(SCRAPE_QUEUES.schedule, { connection: { url: redisUrl } });
  await queue.add(
    "schedule",
    { ...request, scrapeJobId: options?.scrapeJobId },
    { jobId: options?.scrapeJobId ?? jobId }
  );
  await queue.close();

  return {
    jobId,
    source: request.source,
    status: "queued",
    counts: { raw: 0, clean: 0, quarantined: 0, ingested: 0, skippedDuplicate: 0 },
    startedAt: new Date().toISOString(),
  };
}

/** @deprecated use enqueueScrapeJob */
export function planScrapeJob(input: unknown): ScrapeJobManifest {
  return {
    jobId: randomUUID(),
    source: scrapeJobRequestSchema.parse(input).source,
    status: "queued",
    counts: { raw: 0, clean: 0, quarantined: 0, ingested: 0, skippedDuplicate: 0 },
    startedAt: new Date().toISOString(),
  };
}
