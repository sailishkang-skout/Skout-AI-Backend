import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aiService } from "../services/ai.service.js";

const generateEmailSchema = z.object({
  prompt: z.string().min(1, "Prompt is required").max(1000, "Prompt too long"),
});

export async function aiRoutes(app: FastifyInstance) {
  app.get("/ai/drafts", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    return reply.send(await aiService.listDrafts(workspaceId));
  });

  /** POST /ai/generate-email — generate an HTML email body + subject from a natural-language prompt */
  app.post("/ai/generate-email", async (request, reply) => {
    const parse = generateEmailSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.errors[0]?.message ?? "Invalid request" });
    }
    try {
      const result = await aiService.generateEmail(parse.data.prompt, app.config.OPENAI_API_KEY);
      return reply.send(result);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message ?? "Internal error" });
    }
  });
}
