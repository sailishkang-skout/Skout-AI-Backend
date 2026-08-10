import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { aiService } from "../services/ai.service.js";
import {
  suggestNextBestAction,
  recordSuggestion,
  markSuggestionAccepted,
  getSuggestionStats,
} from "../services/next-best-action.service.js";
import { AI_DRAFT_STATUSES, buildAiDraftService } from "../services/ai-draft.service.js";
import { sendApprovedDraftEmail, type DraftSendResult } from "../services/ai-draft-send.service.js";
import { computeOutcomeInsights, insightsToPrompt } from "../services/outcome-insights.service.js";
import { buildChatGrounding } from "../services/ai-chat-context.service.js";
import { createWorkspaceToolRunner } from "../services/ai-workspace-tools.service.js";
import { readAiExport } from "../services/ai-export.service.js";
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
  /** "dexter" = voice-first agent. "cro" = R19.2 admin-only exec rollup — 403s for non-admins. */
  agent: z.enum(["skout", "dexter", "cro"]).optional().default("skout"),
  context: z
    .object({
      subject: z.string().max(500).optional(),
      body: z.string().max(20000).optional(),
      kind: z.enum(["email", "sequence", "general"]).optional(),
      /** Current app path, e.g. /lists or /import — helps pick product guides. */
      page: z.string().max(200).optional(),
      prospectId: z.string().min(1).max(200).optional(),
      threadId: z.string().uuid().optional(),
      listId: z.string().uuid().optional(),
      sequenceId: z.string().uuid().optional(),
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
   * POST /ai/chat — workspace + product Q&A, plus templates/emails/sequences.
   *
   * Grounding: live workspace facts (credits, lists, sequences, …) and product guide snippets.
   *
   * AI segregation:
   * - **Auto** — persist/apply immediately (sequences created server-side; emails applied client-side).
   * - **Ask** — propose only; client confirms. Optionally `stageForReview` queues email into AI Review.
   */
  app.post("/ai/chat", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const body = chatSchema.parse(request.body ?? {});

    const isAdmin = request.role === "owner" || request.role === "admin";
    if (body.agent === "cro" && !isAdmin) {
      return reply.status(403).send({ error: "CRO Copilot is owner/admin only" });
    }

    try {
      const lastUser = [...body.messages].reverse().find((m) => m.role === "user")?.content;
      const [insights, grounding] = await Promise.all([
        app.db
          ? computeOutcomeInsights(app.db, workspaceId)
              .then(insightsToPrompt)
              .catch(() => null)
          : Promise.resolve(null),
        buildChatGrounding(app.db ?? null, app.config, workspaceId, {
          userMessage: lastUser,
          page: body.context?.page,
        }),
      ]);

      const toolRunner = createWorkspaceToolRunner(app.db ?? null, app.config, workspaceId, isAdmin);

      const result = await aiService.chat(
        {
          messages: body.messages,
          context: body.context,
          insights,
          workspaceFacts: grounding.workspaceFacts,
          appGuides: grounding.appGuides,
          toolRunner,
          agent: body.agent,
        },
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
        exports: toolRunner.getCreatedExports(),
        mode: body.mode,
        segregated: Boolean(draftId),
      });
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message ?? "chat_failed" });
    }
  });

  /**
   * GET /ai/exports/download — stream a CSV the assistant generated via export_dataset.
   * The key is namespaced to the caller's workspace, so cross-workspace access is rejected.
   */
  app.get("/ai/exports/download", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const { key } = z.object({ key: z.string().min(1) }).parse(request.query ?? {});

    if (!key.startsWith(`exports/${workspaceId}/`)) {
      return reply.status(403).send({ error: "invalid_export_key" });
    }

    try {
      const content = await readAiExport(app.config, key);
      const filename = key.split("/").pop() ?? "export.csv";
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(content);
    } catch {
      return reply.status(404).send({ error: "export_not_found" });
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

  const aiAuditSchema = z.object({
    agent: z.enum(["skout", "dexter", "cro"]),
    action: z.string().min(1).max(100),
    entityType: z.string().min(1).max(50),
    entityId: z.string().uuid(),
    details: z.record(z.unknown()).optional(),
  });

  // POST /ai/audit — R15.2. Logs an AI-executed write action (e.g. Dexter's guarded
  // enroll_list) to the shared audit_logs table, attributed to the specific user who confirmed
  // it. Called by the client right after a confirmed action actually succeeds — not on proposal.
  app.post("/ai/audit", async (request, reply) => {
    const parse = aiAuditSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.errors[0]?.message ?? "Invalid request" });
    }
    if (!request.workspaceId || !request.userId) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    if (!app.db) return reply.status(500).send({ error: "Database not available" });

    await app.db.insert(schema.auditLogs).values({
      workspaceId: request.workspaceId,
      actorId: request.userId,
      action: `ai:${parse.data.agent}:${parse.data.action}`,
      entityType: parse.data.entityType,
      entityId: parse.data.entityId,
      afterState: { ...parse.data.details, executedByAgent: parse.data.agent, onBehalfOfUserId: request.userId },
    });
    return reply.code(201).send({ data: { logged: true } });
  });

  const nextBestActionSchema = z.object({
    entityType: z.enum(["contact", "deal"]),
    entityId: z.string().uuid(),
  });

  // POST /ai/next-best-action — R20.3. Suggests one concrete next step for a CRM contact/deal,
  // grounded in its own recent activity/task/meeting history (never fabricated). Persists the
  // suggestion (accepted or not) so acceptance rate is measurable — see GET .../stats below.
  app.post("/ai/next-best-action", async (request, reply) => {
    const parse = nextBestActionSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.errors[0]?.message ?? "Invalid request" });
    }
    if (!request.workspaceId) return reply.status(401).send({ error: "Unauthorized" });
    if (!app.db) return reply.status(500).send({ error: "Database not available" });

    try {
      const result = await suggestNextBestAction(app.db, app.config, request.workspaceId, parse.data.entityType, parse.data.entityId);
      if (!result) return reply.status(404).send({ error: "not_found" });
      const suggestionId = await recordSuggestion(
        app.db,
        request.workspaceId,
        parse.data.entityType,
        parse.data.entityId,
        request.userId,
        result.suggestion
      );
      return reply.send({ data: { ...result, suggestionId } });
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message ?? "Internal error" });
    }
  });

  const createTaskFromSuggestionSchema = z.object({
    entityType: z.enum(["contact", "deal"]),
    entityId: z.string().uuid(),
    title: z.string().min(1).max(255),
    suggestionId: z.string().uuid().optional(),
  });

  // POST /ai/next-best-action/create-task — materializes a suggestion into a real CRM task.
  app.post("/ai/next-best-action/create-task", async (request, reply) => {
    const parse = createTaskFromSuggestionSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.errors[0]?.message ?? "Invalid request" });
    }
    if (!request.workspaceId) return reply.status(401).send({ error: "Unauthorized" });
    if (!app.db) return reply.status(500).send({ error: "Database not available" });

    const [row] = await app.db
      .insert(schema.tasks)
      .values({
        workspaceId: request.workspaceId,
        assignedTo: request.userId,
        title: parse.data.title,
        dueDate: new Date(),
        priority: "medium",
        status: "open",
        relatedEntityType: parse.data.entityType,
        relatedEntityId: parse.data.entityId,
      })
      .returning();

    if (parse.data.suggestionId && row) {
      await markSuggestionAccepted(app.db, request.workspaceId, parse.data.suggestionId, "create_task", row.id);
    }
    return reply.code(201).send({ data: row });
  });

  const enrollFromSuggestionSchema = z.object({
    entityId: z.string().uuid(),
    sequenceId: z.string().uuid(),
    suggestionId: z.string().uuid().optional(),
  });

  // POST /ai/next-best-action/enroll — R20.3 "Enroll in sequence" accept option, alongside
  // "Create task". Only meaningful for a contact (a deal has no single prospectId to enroll —
  // see the R14.1 identity-gap note in docs/tickets) whose `sourceProspectId` links it back to
  // the corpus prospect the sequence engine actually enrolls.
  app.post("/ai/next-best-action/enroll", async (request, reply) => {
    const parse = enrollFromSuggestionSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.errors[0]?.message ?? "Invalid request" });
    }
    if (!request.workspaceId) return reply.status(401).send({ error: "Unauthorized" });
    if (!app.db) return reply.status(500).send({ error: "Database not available" });

    const [contact] = await app.db
      .select({ sourceProspectId: schema.contacts.sourceProspectId })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.id, parse.data.entityId), eq(schema.contacts.workspaceId, request.workspaceId)))
      .limit(1);
    if (!contact) return reply.status(404).send({ error: "contact_not_found" });
    if (!contact.sourceProspectId) {
      return reply.status(422).send({
        error: "contact_not_linked_to_prospect",
        message: "This contact isn't linked to a corpus prospect yet, so it can't be enrolled in a sequence.",
      });
    }

    const seqSvc = buildSequenceService(app.db);
    if (!seqSvc) return reply.status(500).send({ error: "Database not available" });

    try {
      const result = await seqSvc.enroll(parse.data.sequenceId, request.workspaceId, {
        prospectIds: [contact.sourceProspectId],
      });
      if (parse.data.suggestionId) {
        await markSuggestionAccepted(app.db, request.workspaceId, parse.data.suggestionId, "enroll_sequence", parse.data.sequenceId);
      }
      return reply.code(201).send({ data: result });
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message ?? "Could not enroll in sequence" });
    }
  });

  // GET /ai/next-best-action/stats — R20.3 AC: acceptance rate must be measurable.
  app.get("/ai/next-best-action/stats", async (request, reply) => {
    if (!request.workspaceId) return reply.status(401).send({ error: "Unauthorized" });
    if (!app.db) return reply.status(500).send({ error: "Database not available" });
    const stats = await getSuggestionStats(app.db, request.workspaceId);
    return reply.send({ data: stats });
  });
}
