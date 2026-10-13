import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { guardWithReleaseGate } from "../services/enrichment/release-gate.js";
import { z } from "zod";
import type { Db } from "@skout/db";
import { assertPermission } from "@skout/auth";
import { HttpError, requireWorkspaceId } from "../utils/http.js";
import { CaptureError, type CaptureActor } from "../services/enrichment/capture-ingest.service.js";
import {
  audienceFiltersSchema,
  deleteAudience,
  getAudience,
  listAudiences,
  previewAudience,
  saveAudience,
} from "../services/enrichment/audience.service.js";
import {
  CAMPAIGN_APPROVE_PERMISSION,
  createCampaign,
  dismissCampaign,
  getCampaign,
  jobChangeReviewQueue,
  launchCampaign,
  listCampaigns,
  refreshCampaign,
  reviewCampaign,
  setRecipientDecision,
  submitCampaign,
  updateDraft,
} from "../services/enrichment/campaign.service.js";
import { enqueueSequenceAdvanceJob } from "../workers/sequence-enrollment.queue.js";

const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(160);
const comment = z.string().trim().max(2_000).optional();
const audienceBody = z.object({ name, filters: audienceFiltersSchema }).strict();
const previewBody = z.object({ filters: audienceFiltersSchema }).strict();
const createCampaignBody = z
  .object({ name, audienceId: uuid.optional(), prospectIds: z.array(z.string().min(1).max(200)).min(1).max(500).optional() })
  .strict()
  .refine((body) => Boolean(body.audienceId) !== Boolean(body.prospectIds), { message: "Give either audienceId or prospectIds" });
const draftBody = z
  .object({
    steps: z
      .array(
        z
          .object({
            order: z.number().int().min(1).max(10),
            delayDays: z.number().int().min(0).max(60),
            subject: z.string().trim().max(200),
            body: z.string().max(10_000),
          })
          .strict()
      )
      .min(1)
      .max(6),
  })
  .strict();
const decisionBody = z.object({ decision: z.enum(["included", "removed"]), comment }).strict();
const reviewBody = z.object({ decision: z.enum(["approved", "rejected"]), comment, consentBasis: z.string().trim().min(2).max(120).optional() }).strict();
const dismissBody = z.object({ comment }).strict();

type Permission = "enrichment:read" | "enrichment:enrich" | typeof CAMPAIGN_APPROVE_PERMISSION;

/**
 * ENR-05 — audiences, the campaign composer, approval and launch.
 *
 * Building and editing a campaign needs `enrichment:enrich`. Approving and launching one needs
 * the send permission. Launch is refused without a recorded approval; the rule is enforced in
 * the service and again by the sequence worker at send time, not by which buttons are shown.
 */
export async function enrichmentCampaignRoutes(app: FastifyInstance) {
  guardWithReleaseGate(app);
  async function authorize(request: FastifyRequest, permission: Permission): Promise<{ db: Db; actor: CaptureActor }> {
    if (!app.db) throw new HttpError("database_unavailable", 503);
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, permission);
    return { db: app.db, actor: { workspaceId, userId: request.userId } };
  }

  /** Runs a handler, turning service errors into their status and a readable message. */
  async function handle(reply: FastifyReply, run: () => Promise<unknown>, status = 200) {
    try {
      return reply.status(status).send(await run());
    } catch (error) {
      if (error instanceof CaptureError) return reply.status(error.statusCode).send({ ok: false, error: error.message, code: error.code });
      if (error instanceof HttpError) return reply.status(error.statusCode).send({ ok: false, error: error.message, code: "sequence_error" });
      throw error;
    }
  }
  const campaignId = (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    if (!uuid.safeParse(id).success) throw new CaptureError("campaign_not_found", 404, "This campaign does not exist in your workspace.");
    return id;
  };

  const mutation = { config: { rateLimit: { max: 30, timeWindow: 60000 } } };
  const launching = { config: { rateLimit: { max: 5, timeWindow: 60000 } } };

  // ── Audiences ───────────────────────────────────────────────────────────────

  // Live counts and a first page of matches while the filters are being edited.
  app.post("/enrichment/audiences/preview", { config: { rateLimit: { max: 120, timeWindow: 60000 } } }, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const body = previewBody.parse(request.body ?? {});
    return reply.send({ workspaceId: actor.workspaceId, ...(await previewAudience(db, actor.workspaceId, body.filters)) });
  });

  app.get("/enrichment/audiences", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    return reply.send({ workspaceId: actor.workspaceId, audiences: await listAudiences(db, actor.workspaceId) });
  });

  app.post("/enrichment/audiences", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:enrich");
    const body = audienceBody.parse(request.body ?? {});
    return handle(reply, async () => ({ workspaceId: actor.workspaceId, audience: await saveAudience(db, actor, body) }), 201);
  });

  app.get("/enrichment/audiences/:id", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const { id } = request.params as { id: string };
    const found = uuid.safeParse(id).success ? await getAudience(db, actor.workspaceId, id) : null;
    if (!found) return reply.status(404).send({ error: "audience_not_found" });
    return reply.send({ workspaceId: actor.workspaceId, ...found });
  });

  // Saving again refreshes the audience's list with the people who match now.
  app.put("/enrichment/audiences/:id", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:enrich");
    const { id } = request.params as { id: string };
    const body = audienceBody.parse(request.body ?? {});
    if (!uuid.safeParse(id).success) return reply.status(404).send({ error: "audience_not_found" });
    return handle(reply, async () => ({ workspaceId: actor.workspaceId, audience: await saveAudience(db, actor, { id, ...body }) }));
  });

  app.delete("/enrichment/audiences/:id", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:enrich");
    const { id } = request.params as { id: string };
    const removed = uuid.safeParse(id).success ? await deleteAudience(db, actor, id) : false;
    if (!removed) return reply.status(404).send({ error: "audience_not_found" });
    return reply.send({ success: true, workspaceId: actor.workspaceId });
  });

  // ── Campaigns ───────────────────────────────────────────────────────────────

  app.get("/enrichment/campaigns", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const campaigns = await listCampaigns(db, actor.workspaceId);
    return reply.send({ workspaceId: actor.workspaceId, campaigns, total: campaigns.length });
  });

  // Job-change suggestions waiting for a person. Registered before "/:id".
  app.get("/enrichment/campaigns/review-queue", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    const items = await jobChangeReviewQueue(db, app.config, actor.workspaceId);
    return reply.send({ workspaceId: actor.workspaceId, items, total: items.length });
  });

  // Builds a draft: evaluates each recipient and composes their claims. Nobody is enrolled.
  app.post("/enrichment/campaigns", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:enrich");
    const body = createCampaignBody.parse(request.body ?? {});
    return handle(reply, async () => ({ workspaceId: actor.workspaceId, campaign: await createCampaign(db, app.config, actor, body) }), 201);
  });

  app.get("/enrichment/campaigns/:id", async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:read");
    return handle(reply, async () => ({ workspaceId: actor.workspaceId, ...(await getCampaign(db, app.config, actor.workspaceId, campaignId(request))) }));
  });

  app.put("/enrichment/campaigns/:id/draft", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:enrich");
    const body = draftBody.parse(request.body ?? {});
    return handle(reply, async () => ({ workspaceId: actor.workspaceId, ...(await updateDraft(db, actor, campaignId(request), body.steps)) }));
  });

  app.put("/enrichment/campaigns/:id/recipients/:prospectId", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:enrich");
    const { prospectId } = request.params as { prospectId: string };
    const body = decisionBody.parse(request.body ?? {});
    return handle(reply, async () => ({ workspaceId: actor.workspaceId, recipient: await setRecipientDecision(db, actor, campaignId(request), prospectId, body) }));
  });

  // Re-reads eligibility and evidence for every recipient.
  app.post("/enrichment/campaigns/:id/refresh", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:enrich");
    return handle(reply, async () => ({ workspaceId: actor.workspaceId, ...(await refreshCampaign(db, app.config, actor, campaignId(request))) }));
  });

  app.post("/enrichment/campaigns/:id/submit", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:enrich");
    return handle(reply, async () => ({ workspaceId: actor.workspaceId, ...(await submitCampaign(db, app.config, actor, campaignId(request))) }));
  });

  // The recorded human decision on recipients and copy.
  app.post("/enrichment/campaigns/:id/review", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, CAMPAIGN_APPROVE_PERMISSION);
    const body = reviewBody.parse(request.body ?? {});
    return handle(reply, async () => ({ workspaceId: actor.workspaceId, ...(await reviewCampaign(db, app.config, actor, campaignId(request), body)) }));
  });

  app.post("/enrichment/campaigns/:id/dismiss", mutation, async (request, reply) => {
    const { db, actor } = await authorize(request, "enrichment:enrich");
    const body = dismissBody.parse(request.body ?? {});
    return handle(reply, async () => ({ workspaceId: actor.workspaceId, ...(await dismissCampaign(db, app.config, actor, campaignId(request), body.comment)) }));
  });

  // Creates the sequence and enrolls the approved recipients. 409 without a recorded approval.
  app.post("/enrichment/campaigns/:id/launch", launching, async (request, reply) => {
    const { db, actor } = await authorize(request, CAMPAIGN_APPROVE_PERMISSION);
    return handle(reply, async () => {
      const id = campaignId(request);
      const { newEnrollments, ...result } = await launchCampaign(db, app.config, actor, id);
      for (const enrollment of newEnrollments) {
        const delayMs =
          app.config.BYPASS_BUSINESS_HOURS || !enrollment.firstStepScheduledAt ? 0 : Math.max(0, enrollment.firstStepScheduledAt.getTime() - Date.now());
        enqueueSequenceAdvanceJob(
          app.config,
          { enrollmentId: enrollment.enrollmentId, workspaceId: actor.workspaceId, prospectId: enrollment.prospectId, sequenceId: result.sequenceId },
          delayMs
        ).catch((error: unknown) => request.log.warn({ err: error, enrollmentId: enrollment.enrollmentId }, "failed to enqueue campaign sequence job"));
      }
      return { workspaceId: actor.workspaceId, ...result, ...(await getCampaign(db, app.config, actor.workspaceId, id)) };
    });
  });
}
