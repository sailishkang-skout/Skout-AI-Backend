import type { FastifyInstance } from "fastify";
import { aiService } from "../services/ai.service.js";

export async function aiRoutes(app: FastifyInstance) {
  app.get("/ai/drafts", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    return reply.send(await aiService.listDrafts(workspaceId));
  });

  app.post("/ai/chat", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const body = (request.body ?? {}) as {
      messages?: { role: string; content: string }[];
      mode?: "auto" | "ask";
      agent?: "skout" | "dexter";
      context?: Record<string, string>;
    };
    const messages =
      body.messages?.map((m) => ({
        role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
        content: String(m.content ?? ""),
      })) ?? [];

    const result = await aiService.chat({
      messages,
      mode: body.mode ?? "ask",
      agent: body.agent ?? "skout",
      context: body.context,
    });

    return reply.send({ ...result, workspaceId });
  });
}
