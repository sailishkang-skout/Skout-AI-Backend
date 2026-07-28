import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createLogger } from "@skout/observability";
import { buildLinkedinAccountService, type MessagingChannel } from "../services/linkedin-account.service.js";

const log = createLogger("unipile-webhook");

/**
 * Unipile hosted-auth notify callback.
 * Body shape varies; we accept common account_id / name / provider fields.
 */
export async function unipileWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/unipile/hosted-auth", async (request, reply) => {
    const query = z
      .object({ workspaceId: z.string().uuid() })
      .safeParse(request.query ?? {});
    if (!query.success) {
      return reply.status(400).send({ error: "workspaceId_required" });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const unipileAccountId = String(
      body.account_id ?? body.accountId ?? body.id ?? ""
    ).trim();
    if (!unipileAccountId) {
      log.warn("Unipile notify missing account id", { body });
      return reply.status(400).send({ error: "account_id_required" });
    }

    const providerRaw = String(body.provider ?? body.type ?? "LINKEDIN").toUpperCase();
    const channel: MessagingChannel = providerRaw.includes("WHATSAPP") ? "whatsapp" : "linkedin";
    const displayName =
      typeof body.name === "string"
        ? body.name
        : typeof body.display_name === "string"
          ? body.display_name
          : undefined;

    const svc = buildLinkedinAccountService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });

    const account = await svc.connect(query.data.workspaceId, {
      unipileAccountId,
      displayName,
      channel,
      phone: typeof body.phone === "string" ? body.phone : undefined,
    });

    log.info("Unipile account connected via hosted auth", {
      workspaceId: query.data.workspaceId,
      channel,
      unipileAccountId,
      accountId: account.id,
    });

    return reply.send({ ok: true, accountId: account.id, channel });
  });
}
