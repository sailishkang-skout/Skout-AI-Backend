import type { FastifyInstance } from "fastify";
import { addSuppression, decodeUnsubscribeToken } from "../services/suppression.service.js";

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title><style>body{font-family:system-ui,sans-serif;background:#f6f7f9;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}main{background:#fff;border:1px solid #e3e5e8;border-radius:12px;padding:32px;max-width:420px;text-align:center}button{background:#111;color:#fff;border:0;border-radius:8px;padding:10px 20px;font-size:14px;cursor:pointer}p{color:#444;line-height:1.5}</style></head><body><main>${body}</main></body></html>`;
}

/**
 * Public (unauthenticated) unsubscribe link sent in outbound emails.
 * GET only shows a confirmation page — link scanners/prefetchers issue GETs and must not
 * unsubscribe anyone. The state change happens on POST (the button, and RFC 8058
 * `List-Unsubscribe=One-Click` mail-client requests).
 */
export async function unsubscribeRoutes(app: FastifyInstance) {
  app.get<{ Params: { token: string } }>("/unsubscribe/:token", async (request, reply) => {
    const payload = decodeUnsubscribeToken(app.config, request.params.token);
    if (!payload || typeof payload.email !== "string" || typeof payload.workspaceId !== "string") {
      return reply.status(400).send({ error: "invalid_token" });
    }

    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(
      page(
        `<p>Unsubscribe <strong>${payload.email.replace(/[<>&"]/g, "")}</strong> from future emails?</p>` +
          `<form method="post" action=""><button type="submit">Confirm unsubscribe</button></form>`
      )
    );
  });

  app.post<{ Params: { token: string } }>("/unsubscribe/:token", async (request, reply) => {
    const payload = decodeUnsubscribeToken(app.config, request.params.token);
    if (!payload || typeof payload.email !== "string" || typeof payload.workspaceId !== "string") {
      return reply.status(400).send({ error: "invalid_token" });
    }

    const db = app.db;
    if (db) {
      await addSuppression(db, payload.workspaceId, payload.email, "unsubscribed");
    }

    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(page(`<p>You have been unsubscribed and will not receive further emails.</p>`));
  });
}
