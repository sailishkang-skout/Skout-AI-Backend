import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aiService } from "../services/ai.service.js";
import { AI_DRAFT_STATUSES, buildAiDraftService } from "../services/ai-draft.service.js";
import { HttpError } from "../utils/http.js";

const generateEmailSchema = z.object({
  prompt: z.string().min(1, "Prompt is required").max(1000, "Prompt too long"),
});

const listQuerySchema = z.object({
  status: z.enum(AI_DRAFT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const createDraftSchema = z.object({
  prospectId: z.string().min(1),
  subject: z.string().min(1).max(500).optional(),
  body: z.string().min(1).max(20000).optional(),
  prompt: z.string().min(1).max(1000).optional(),
  fullName: z.string().optional(),
  title: z.string().optional(),
  companyName: z.string().optional(),
  companyDomain: z.string().optional(),
});

const patchDraftSchema = z
  .object({
    subject: z.string().min(1).max(500).optional(),
    body: z.string().min(1).max(20000).optional(),
  })
  .refine((v) => v.subject !== undefined || v.body !== undefined, {
    message: "At least one of subject or body is required",
  });

const bulkApproveSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

function draftsOr503(app: FastifyInstance) {
  if (!app.db) throw new HttpError("database_unavailable", 503);
  return buildAiDraftService(app.db);
}

export async function aiRoutes(app: FastifyInstance) {
  app.get("/ai/drafts", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const query = listQuerySchema.parse(request.query ?? {});
    try {
      const drafts = draftsOr503(app);
      return reply.send(await drafts.list(workspaceId, query));
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 503) {
        return reply.send({ workspaceId, data: [], total: 0 });
      }
      throw err;
    }
  });

  app.post("/ai/drafts/bulk-approve", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const body = bulkApproveSchema.parse(request.body ?? {});
    const drafts = draftsOr503(app);
    const result = await drafts.bulkApprove(workspaceId, body.ids, request.userId);
    return reply.send(result);
  });

  app.get("/ai/drafts/:id", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const drafts = draftsOr503(app);
    const draft = await drafts.getById(workspaceId, id);
    if (!draft) return reply.status(404).send({ error: "draft_not_found" });
    return reply.send(draft);
  });

  /** Create a draft — either from provided subject/body or OpenRouter generation. */
  app.post("/ai/drafts", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const body = createDraftSchema.parse(request.body ?? {});
    const drafts = draftsOr503(app);

    let subject = body.subject;
    let content = body.body;
    let model = "manual";

    if (!subject || !content) {
      const prompt =
        body.prompt ??
        [
          body.fullName ? `Prospect: ${body.fullName}` : null,
          body.title ? `Title: ${body.title}` : null,
          body.companyName || body.companyDomain
            ? `Company: ${body.companyName ?? body.companyDomain}`
            : null,
          "Write a concise B2B outreach email.",
        ]
          .filter(Boolean)
          .join(". ");

      const generated = await aiService.generateEmail(prompt, app.config.OPENROUTER_API_KEY);
      subject = subject ?? (generated.subject || `Outreach to ${body.fullName ?? "prospect"}`);
      content = content ?? generated.html;
      model = process.env.AI_MODEL ?? "openai/gpt-4o-mini";
    }

    const draft = await drafts.create(workspaceId, {
      prospectId: body.prospectId,
      subject: subject!,
      body: content!,
      model,
    });
    return reply.status(201).send(draft);
  });

  app.patch("/ai/drafts/:id", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const patch = patchDraftSchema.parse(request.body ?? {});
    const drafts = draftsOr503(app);
    const draft = await drafts.update(workspaceId, id, patch, request.userId);
    return reply.send(draft);
  });

  app.post("/ai/drafts/:id/approve", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const drafts = draftsOr503(app);
    const draft = await drafts.approve(workspaceId, id, request.userId);
    return reply.send(draft);
  });

  app.post("/ai/drafts/:id/reject", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const drafts = draftsOr503(app);
    const draft = await drafts.reject(workspaceId, id, request.userId);
    return reply.send(draft);
  });

  /** POST /ai/generate-email — generate an HTML email body + subject from a natural-language prompt */
  app.post("/ai/generate-email", async (request, reply) => {
    const parse = generateEmailSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.errors[0]?.message ?? "Invalid request" });
    }
    try {
      const result = await aiService.generateEmail(parse.data.prompt, app.config.OPENROUTER_API_KEY);
      return reply.send(result);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message ?? "Internal error" });
    }
  });
}
