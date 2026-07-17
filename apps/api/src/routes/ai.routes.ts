import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aiService } from "../services/ai.service.js";
import { AI_DRAFT_STATUSES, buildAiDraftService } from "../services/ai-draft.service.js";
import { sendApprovedDraftEmail, type DraftSendResult } from "../services/ai-draft-send.service.js";
import { computeOutcomeInsights, insightsToPrompt } from "../services/outcome-insights.service.js";
import { buildSequenceService } from "../services/sequence.service.js";
import { HttpError } from "../utils/http.js";

const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      })
    )
    .min(1)
    .max(30),
  mode: z.enum(["auto", "ask"]).default("ask"),
  /** When true (Ask mode), email actions are also queued in AI Review for human approval. */
  stageForReview: z.boolean().optional().default(false),
  context: z
    .object({
      subject: z.string().max(500).optional(),
      body: z.string().max(20000).optional(),
      kind: z.enum(["email", "sequence", "general"]).optional(),
      prospectId: z.string().min(1).max(200).optional(),
      threadId: z.string().uuid().optional(),
    })
    .optional(),
});

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

    // Send each standalone (non-enrollment) approved draft that hasn't been delivered yet.
    let sent = 0;
    const sendFailures: { id: string; reason?: string }[] = [];
    if (app.db) {
      for (const id of body.ids) {
        const draft = await drafts.getById(workspaceId, id);
        if (!draft || draft.enrollmentStepId || draft.status !== "approved") continue;
        const res = await sendApprovedDraftEmail(app.db, app.config, {
          id: draft.id,
          workspaceId,
          prospectId: draft.prospectId,
          subject: draft.subject,
          body: draft.body,
        });
        if (res.sent) sent += 1;
        else sendFailures.push({ id: draft.id, reason: res.reason });
      }
    }
    return reply.send({ ...result, sent, sendFailures });
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

      const insights = app.db
        ? insightsToPrompt(await computeOutcomeInsights(app.db, workspaceId).catch(() => null))
        : null;
      const generated = await aiService.generateEmail(prompt, app.config.OPENROUTER_API_KEY, insights);
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
    let draft = await drafts.approve(workspaceId, id, request.userId);

    // Standalone drafts (not tied to a sequence step) send immediately on approve.
    // Enrollment-linked drafts are delivered by the sequence worker to avoid double-send.
    // sendApprovedDraftEmail creates the outbound Inbox message and marks status `sent`.
    let send: DraftSendResult | undefined;
    if (app.db && !draft.enrollmentStepId && draft.status !== "sent") {
      send = await sendApprovedDraftEmail(app.db, app.config, {
        id: draft.id,
        workspaceId,
        prospectId: draft.prospectId,
        subject: draft.subject,
        body: draft.body,
      });
      if (send?.sent) {
        draft = (await drafts.getById(workspaceId, id)) ?? draft;
      } else if (send && !send.sent) {
        app.log.warn({ draftId: draft.id, reason: send.reason }, "Approved draft could not be sent");
      }
    }
    return reply.send({ ...draft, send });
  });

  app.post("/ai/drafts/:id/reject", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const drafts = draftsOr503(app);
    const draft = await drafts.reject(workspaceId, id, request.userId);
    return reply.send(draft);
  });

  /**
   * POST /ai/chat — conversational assistant for templates/emails/sequences.
   *
   * AI segregation:
   * - **Auto** — persist/apply immediately (sequences created server-side; emails applied client-side).
   * - **Ask** — propose only; client confirms. Optionally `stageForReview` queues email into AI Review.
   */
  app.post("/ai/chat", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const body = chatSchema.parse(request.body ?? {});
    try {
      const insights = app.db
        ? insightsToPrompt(await computeOutcomeInsights(app.db, workspaceId).catch(() => null))
        : null;
      const result = await aiService.chat(
        { messages: body.messages, context: body.context, insights },
        app.config.OPENROUTER_API_KEY
      );

      let applied = false;
      let sequenceId: string | undefined;
      let draftId: string | undefined;

      if (body.mode === "auto" && result.action.type === "sequence" && app.db) {
        const seqSvc = buildSequenceService(app.db);
        if (seqSvc) {
          const created = await seqSvc.createGeneratedSequence(workspaceId, {
            name: result.action.name,
            steps: result.action.steps,
          });
          applied = true;
          sequenceId = created.id;
        }
      }

      // Ask + stageForReview: segregate AI email into the review queue (never auto-send).
      if (
        body.mode === "ask" &&
        body.stageForReview &&
        result.action.type === "email" &&
        body.context?.prospectId &&
        app.db
      ) {
        try {
          const drafts = buildAiDraftService(app.db);
          const draft = await drafts.create(workspaceId, {
            prospectId: body.context.prospectId,
            subject: result.action.subject || "(no subject)",
            body: result.action.html,
            model: process.env.AI_MODEL ?? "openai/gpt-4o-mini",
            // Do not attach inbox threadId here — approve+send creates the Sent/Outbox thread.
            threadId: null,
            status: "pending_review",
          });
          draftId = draft.id;
        } catch (err) {
          app.log.warn({ err }, "Could not stage AI chat email for review");
        }
      }

      return reply.send({
        reply: result.reply,
        action: result.action,
        applied,
        sequenceId,
        draftId,
        mode: body.mode,
        segregated: Boolean(draftId),
      });
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message ?? "chat_failed" });
    }
  });

  /** POST /ai/generate-email — generate an HTML email body + subject from a natural-language prompt */
  app.post("/ai/generate-email", async (request, reply) => {
    const parse = generateEmailSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.errors[0]?.message ?? "Invalid request" });
    }
    try {
      const workspaceId = request.workspaceId ?? "unknown";
      const insights = app.db
        ? insightsToPrompt(await computeOutcomeInsights(app.db, workspaceId).catch(() => null))
        : null;
      const result = await aiService.generateEmail(
        parse.data.prompt,
        app.config.OPENROUTER_API_KEY,
        insights
      );
      return reply.send(result);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message ?? "Internal error" });
    }
  });
}
