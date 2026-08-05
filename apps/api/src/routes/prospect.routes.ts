import type { FastifyInstance } from "fastify";
import { prospectService } from "../services/prospect.service.js";

export async function prospectRoutes(app: FastifyInstance) {
app.get("/enrichment/credits", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "00000000-0000-4000-8000-000000000001";
    return reply.send({ workspaceId, balance: 0 });
  });

  app.get("/enrichment/jobs", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "00000000-0000-4000-8000-000000000001";
    const result = await prospectService.listJobs(workspaceId);
    return reply.send(result);
  });

  app.get("/enrichment/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "00000000-0000-4000-8000-000000000001";
    const job = await prospectService.getJob(workspaceId, id);
    if (!job) {
      return reply.status(404).send({ error: "Job not found" });
    }
    return reply.send(job);
  });

  app.post("/enrichment/jobs/:id/retry", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "00000000-0000-4000-8000-000000000001";
    const result = await prospectService.retryJob(workspaceId, id);
    if (!result) {
      return reply.status(404).send({ error: "Job not found" });
    }
    return reply.send(result);
  });

  app.get("/prospects", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const result = await prospectService.listActivated(workspaceId);
    return reply.send(result);
  });

  app.post("/prospects/:id/enrich", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const result = await prospectService.enrich(id, workspaceId);
    return reply.status(202).send(result);
  });
}
