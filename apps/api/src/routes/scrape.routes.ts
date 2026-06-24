import type { FastifyInstance } from "fastify";
import { scrapeJobRequestSchema } from "@skout/scraper-contracts";
import {
  createAndEnqueueScrapeJob,
  getScrapeJob,
  listScrapeJobs,
} from "../services/scrape.service.js";
import { errorResponse } from "../utils/http.js";

function isScrapeAdmin(role?: string): boolean {
  return role === "owner" || role === "admin";
}

/** Internal corpus pipeline triggers (strategy §2 Stage 1). */
export async function scrapeRoutes(app: FastifyInstance) {
  app.post("/scrape/jobs", async (request, reply) => {
    if (!isScrapeAdmin(request.role)) {
      return reply.status(403).send(errorResponse("Admin access required for corpus jobs", 403));
    }
    const body = scrapeJobRequestSchema.parse(request.body ?? {});
    if (!app.db) {
      return reply.status(503).send({
        error: "database_unavailable",
        message: "Postgres is not connected. Start with: docker compose up -d postgres",
      });
    }

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
      const hint =
        message.includes("Queue name") || message.includes("queue")
          ? "Rebuild scraper orchestrator: pnpm --filter @skout/scraper-orchestrator build"
          : message.includes("Redis") || message.includes("ECONNREFUSED")
            ? "Start Redis: docker compose up -d redis"
            : undefined;
      return reply.status(503).send({ error: message, message, hint });
    }
  });

  app.get("/scrape/jobs", async (request, reply) => {
    if (!isScrapeAdmin(request.role)) {
      return reply.status(403).send(errorResponse("Admin access required", 403));
    }
    if (!app.db) return reply.send({ data: [], total: 0 });
    const data = await listScrapeJobs(app.db);
    return reply.send({ data, total: data.length });
  });

  app.get("/scrape/jobs/:id", async (request, reply) => {
    if (!isScrapeAdmin(request.role)) {
      return reply.status(403).send(errorResponse("Admin access required", 403));
    }
    const { id } = request.params as { id: string };
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const job = await getScrapeJob(app.db, id);
    if (!job) return reply.status(404).send({ error: "job_not_found" });
    return reply.send(job);
  });
}
