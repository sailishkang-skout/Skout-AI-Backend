import type { FastifyInstance } from "fastify";
import { scrapeJobRequestSchema } from "@skout/scraper-contracts";
import {
  createAndEnqueueScrapeJob,
  getScrapeJob,
  listScrapeJobs,
} from "../services/scrape.service.js";

/** Internal corpus pipeline triggers (strategy §2 Stage 1). */
export async function scrapeRoutes(app: FastifyInstance) {
  app.post("/scrape/jobs", async (request, reply) => {
    const body = scrapeJobRequestSchema.parse(request.body ?? {});
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });

    try {
      const { job, warning } = await createAndEnqueueScrapeJob(app.db, app.config, body);
      return reply.status(202).send({
        jobId: job.id,
        source: job.source,
        status: job.status,
        seeds: job.seeds,
        counts: {
          raw: job.rawCount ?? 0,
          clean: job.cleanCount ?? 0,
          quarantined: job.quarantinedCount ?? 0,
          ingested: job.ingestedCount ?? 0,
          skippedDuplicate: job.skippedDuplicateCount ?? 0,
        },
        startedAt: job.queuedAt,
        warning,
        error: job.errorMessage ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "enqueue_failed";
      return reply.status(503).send({ error: message });
    }
  });

  app.get("/scrape/jobs", async (request, reply) => {
    if (!app.db) return reply.send({ data: [], total: 0 });
    const data = await listScrapeJobs(app.db);
    return reply.send({ data, total: data.length });
  });

  app.get("/scrape/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const job = await getScrapeJob(app.db, id);
    if (!job) return reply.status(404).send({ error: "job_not_found" });
    return reply.send(job);
  });
}
