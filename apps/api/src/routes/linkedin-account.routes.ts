import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildLinkedinAccountService } from "../services/linkedin-account.service.js";
import { isUnipileConfigured } from "../services/unipile.client.js";

export async function linkedinAccountRoutes(app: FastifyInstance) {
  app.get("/linkedin/accounts", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildLinkedinAccountService(app.db, app.config);
    if (!svc) return reply.send({ workspaceId, data: [], total: 0, unipileConfigured: false });
    const data = await svc.list(workspaceId);
    return reply.send({
      workspaceId,
      data,
      total: data.length,
      unipileConfigured: isUnipileConfigured(app.config),
    });
  });

  app.post("/linkedin/accounts", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildLinkedinAccountService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = z
      .object({
        unipileAccountId: z.string().min(1).max(200),
        displayName: z.string().max(255).optional(),
        linkedinUrl: z.string().url().optional(),
      })
      .parse(request.body ?? {});
    const account = await svc.connect(workspaceId, body);
    return reply.status(201).send(account);
  });

  app.post("/linkedin/accounts/hosted-auth", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildLinkedinAccountService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = z
      .object({
        webBaseUrl: z.string().url(),
      })
      .parse(request.body ?? {});
    const link = await svc.createHostedAuthLink(workspaceId, body.webBaseUrl);
    return reply.send(link);
  });

  app.patch("/linkedin/accounts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildLinkedinAccountService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = z.object({ status: z.enum(["active", "paused"]) }).parse(request.body ?? {});
    const account = await svc.setStatus(workspaceId, id, body.status);
    if (!account) return reply.status(404).send({ error: "linkedin_account_not_found" });
    return reply.send(account);
  });

  app.delete("/linkedin/accounts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildLinkedinAccountService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    await svc.disconnect(workspaceId, id);
    return reply.status(204).send();
  });
}
