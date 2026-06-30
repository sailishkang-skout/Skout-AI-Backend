import type { FastifyInstance } from "fastify";
import { addSuppression, decodeUnsubscribeToken } from "../services/suppression.service.js";

/** Public (unauthenticated) one-click unsubscribe link sent in outbound emails. */
export async function unsubscribeRoutes(app: FastifyInstance) {
  app.get<{ Params: { token: string } }>("/unsubscribe/:token", async (request, reply) => {
    const payload = decodeUnsubscribeToken(app.config, request.params.token);
    if (!payload) {
      return reply.status(400).send({ error: "invalid_token" });
    }

    const db = app.db;
    if (db) {
      await addSuppression(db, payload.workspaceId, payload.email, "unsubscribed");
    }

    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(
      `<html><body><p>You have been unsubscribed and will not receive further emails.</p></body></html>`
    );
  });
}
