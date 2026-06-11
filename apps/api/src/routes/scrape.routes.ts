import type { FastifyInstance } from "fastify";
import { desc } from "drizzle-orm";
import { schema } from "@skout/db";
import { scrapeJobRequestSchema } from "@skout/scraper-contracts";
import { enqueueScrapeJob } from "@skout/scraper-orchestrator";

/** Internal corpus pipeline triggers (strategy §2 Stage 1). */
export async function scrapeRoutes(app: FastifyInstance) {
  app.post("/scrape/jobs", async (request, reply) => {
    const body = scrapeJobRequestSchema.parse(request.body ?? {});
    try {
      const manifest = await enqueueScrapeJob(body);
      return reply.status(202).send(manifest);
    } catch (err) {
      if (process.env.NODE_ENV === "development") {
        return reply.status(202).send({
          jobId: crypto.randomUUID(),
          source: body.source,
          status: "queued",
          counts: { raw: 0, clean: 0, quarantined: 0, ingested: 0, skippedDuplicate: 0 },
          startedAt: new Date().toISOString(),
          warning: "Redis unavailable — job validated but not enqueued",
        });
      }
      throw err;
    }
  });

  app.get("/scrape/jobs", async (request, reply) => {
    if (!app.db) return reply.send({ data: [], total: 0 });
    const rows = await app.db
      .select()
      .from(schema.scrapeJobs)
      .orderBy(desc(schema.scrapeJobs.queuedAt))
      .limit(50);
    return reply.send({ data: rows, total: rows.length });
  });
}
