import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@skout/db";
import { copsErrorBody, copsErrorStatus, isValidIdempotencyKey, resolveCorrelationId } from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { copsIdempotencyStore, requireAnyCopsPermission } from "../services/cops-platform.service.js";
import { withCopsIdempotentReply, type CopsCapturingReply } from "../services/cops-idempotent.js";
import {
  defaultOnboardingDeps,
  listOnboardingEmails,
  OnboardingError,
  previewOnboardingEmail,
  sendOnboardingEmail,
  type OnboardingDeps,
} from "../services/cops-onboarding.service.js";
import { getFollowUpView } from "../services/cops-follow-up.service.js";
import { ActivationError, applyProductEvent, completeManualMilestone, ensureActivationInstance, loadActivation } from "../services/cops-activation.service.js";
import { timingSafeEqual } from "node:crypto";
import { loadProvisionings } from "../services/cops-provisioning.service.js";
import { listBlockers, loadHandoff, loadIntegrations } from "../services/cops-onboarding-signals.service.js";
import { loadFollowUpQueue, QUEUE_REASONS } from "../services/cops-follow-up-queue.service.js";
import { FollowUpActionError, performFollowUpAction } from "../services/cops-follow-up-actions.service.js";
import { sendMail } from "../services/mail.service.js";
import { getOnboardingSettings, setOnboardingSettings } from "../services/cops-onboarding-settings.service.js";
import { applyResendEvent, verifySvixSignature, type ResendEvent } from "../services/cops-email-events.service.js";
import { EnrollmentControlFailure, pauseEnrollment, resumeEnrollment, stopEnrollment } from "../services/cops-stop.service.js";
import { enqueueSequenceAdvanceJob } from "../workers/sequence-enrollment.queue.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sendSchema = z
  .object({
    contact_id: z.string().regex(UUID, "Invalid id").optional(),
    template_key: z.string().trim().min(1).max(64).optional(),
    booking_url: z.string().trim().url().max(500).optional(),
    resend: z.boolean().optional(),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();

const reasonSchema = z.object({ reason: z.string().trim().min(1, "reason is required").max(1000) }).strict();
const queueSchema = z.object({
  owner: z.enum(["me", "all"]).default("me"),
  reason: z.enum(QUEUE_REASONS).optional(),
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
const actionSchema = z
  .object({
    kind: z.enum(["call", "email", "meeting", "task"]),
    account_id: z.string().regex(UUID, "Invalid id"),
    contact_id: z.string().regex(UUID, "Invalid id").optional(),
    queue_item_id: z.string().max(80).optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(20000).optional(),
    due_at: z.string().datetime({ offset: true }).optional(),
    outcome: z.string().trim().max(1000).optional(),
  })
  .strict();

type Reply = CopsCapturingReply;

/**
 * COPS-05 onboarding email. Contract: docs/api/copos-05-onboarding.openapi.yaml.
 * Send keeps its own idempotency on the send row (like COPS-04 provision) so a failed delivery is
 * retried by the same key instead of replaying a stored 502. Sales send onboarding (Bible p.12), so
 * commercial:send is accepted next to onboarding:send; no new permission keys.
 */
export async function copsOnboardingRoutes(app: FastifyInstance, opts: { db: Db; deps?: OnboardingDeps }) {
  const { db } = opts;
  const deps = opts.deps ?? defaultOnboardingDeps(app.config);
  const perms = (ws: string, user: string) => getMemberPermissions(db, ws, user);
  const sendGate = requireAnyCopsPermission(["onboarding:send", "commercial:send"], perms);
  const readGate = requireAnyCopsPermission(["onboarding:read", "commercial:read"], perms);
  // The rep owns the follow-up (Bible p.18, R/A); Sales hold crm:write, CS onboarding:write.
  const followUpGate = requireAnyCopsPermission(["onboarding:write", "crm:write"], perms);
  const idempotency = copsIdempotencyStore(db);

  const ctxOf = (request: { workspaceId?: string; userId?: string; headers: Record<string, unknown> }) => ({
    workspaceId: request.workspaceId!,
    userId: request.userId!,
    requestId: resolveCorrelationId(request.headers["x-request-id"] as string | undefined),
  });

  function invalid(reply: Reply, requestId: string, error: z.ZodError | { path: string; message: string }) {
    const fields =
      error instanceof z.ZodError
        ? error.issues.map((i) => ({ path: i.path.join(".") || "body", code: i.code, message: i.message }))
        : [{ path: error.path, code: "invalid", message: error.message }];
    return reply
      .status(copsErrorStatus("VALIDATION_FAILED"))
      .send(copsErrorBody({ code: "VALIDATION_FAILED", message: fields[0]?.message ?? "Invalid request", requestId, details: { fields } }));
  }

  async function run<T>(reply: Reply, requestId: string, fn: () => Promise<T>, onOk: (value: T) => unknown) {
    try {
      return onOk(await fn());
    } catch (error) {
      if (error instanceof OnboardingError) {
        return reply
          .status(error.status)
          .send(copsErrorBody({ code: error.code, message: error.message, requestId, details: error.details, retryable: error.retryable }));
      }
      if (error instanceof ActivationError) {
        return reply.status(error.status).send(copsErrorBody({ code: error.code, message: error.message, requestId }));
      }
      if (error instanceof FollowUpActionError) {
        return reply
          .status(error.status)
          .send(copsErrorBody({ code: error.code, message: error.message, requestId, details: error.details, retryable: error.code === "EMAIL_NOT_SENT" }));
      }
      if (error instanceof EnrollmentControlFailure) {
        return reply.status(error.status).send(copsErrorBody({ code: error.code, message: error.message, requestId }));
      }
      throw error;
    }
  }

  type IdBody = { Params: { id: string }; Body: unknown };

  app.post<IdBody>("/accounts/:id/onboarding/preview", { preHandler: sendGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
    const parsed = sendSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    return run(reply, ctx.requestId, () => previewOnboardingEmail(db, ctx, request.params.id, parsed.data, deps), (data) => ({ data }));
  });

  app.post<IdBody>("/accounts/:id/onboarding/send", { preHandler: sendGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
    const header = request.headers["idempotency-key"];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key || !isValidIdempotencyKey(key)) {
      return invalid(reply, ctx.requestId, { path: "Idempotency-Key", message: "Idempotency-Key header is required (8 to 128 characters)" });
    }
    const parsed = sendSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    return run(
      reply,
      ctx.requestId,
      () => sendOnboardingEmail(db, ctx, request.params.id, key, parsed.data, deps),
      ({ send, replayed }) => reply.status(replayed ? 200 : 201).send({ data: send })
    );
  });

  app.get<{ Params: { id: string } }>("/accounts/:id/onboarding/emails", { preHandler: readGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
    return { data: await listOnboardingEmails(db, ctx.workspaceId, request.params.id) };
  });

  app.get<{ Params: { id: string } }>("/accounts/:id/follow-up/enrollment", { preHandler: readGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
    return { data: await getFollowUpView(db, ctx.workspaceId, request.params.id) };
  });

  /** Pause and stop need a reason (audited); resume re-queues the next step. */
  for (const action of ["pause", "resume", "stop"] as const) {
    app.post<IdBody>(`/follow-up/enrollments/:id/${action}`, { preHandler: followUpGate }, async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      const ctx = ctxOf(request);
      if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
      let reason = "";
      if (action !== "resume") {
        const parsed = reasonSchema.safeParse(request.body ?? {});
        if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
        reason = parsed.data.reason;
      }
      const actor = { type: "user" as const, id: ctx.userId };
      return run(
        reply,
        ctx.requestId,
        async () => {
          if (action === "pause") {
            await pauseEnrollment(db, { workspaceId: ctx.workspaceId, enrollmentId: request.params.id, actor, reason, correlationId: ctx.requestId });
          } else if (action === "resume") {
            await resumeEnrollment(db, { workspaceId: ctx.workspaceId, enrollmentId: request.params.id, actor, correlationId: ctx.requestId }, (e) =>
              enqueueSequenceAdvanceJob(app.config, e, 0)
            );
          } else {
            const res = await stopEnrollment(db, {
              workspaceId: ctx.workspaceId,
              enrollmentId: request.params.id,
              reason: "REP_STOPPED",
              actor,
              note: reason,
              correlationId: ctx.requestId,
            });
            if (!res.stopped) throw new EnrollmentControlFailure("NOT_ACTIVE", "The follow-up already ended");
          }
        },
        () => ({ data: { id: request.params.id, action } })
      );
    });
  }

  app.get<{ Params: { id: string } }>("/accounts/:id/activation", { preHandler: readGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
    await ensureActivationInstance(db, ctx.workspaceId, request.params.id);
    const data = await loadActivation(db, ctx.workspaceId, request.params.id);
    if (!data) return reply.status(404).send(copsErrorBody({ code: "NOT_PROVISIONED", message: "The account has no provisioned workspace yet", requestId: ctx.requestId }));
    return { data };
  });

  app.post<{ Params: { id: string; key: string }; Body: unknown }>(
    "/accounts/:id/activation/milestones/:key/complete",
    { preHandler: followUpGate },
    async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      const ctx = ctxOf(request);
      if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
      const header = request.headers["idempotency-key"];
      const key = Array.isArray(header) ? header[0] : header;
      if (!key || !isValidIdempotencyKey(key)) {
        return invalid(reply, ctx.requestId, { path: "Idempotency-Key", message: "Idempotency-Key header is required (8 to 128 characters)" });
      }
      const parsed = reasonSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        () => completeManualMilestone(db, ctx, request.params.id, request.params.key, parsed.data.reason, key),
        (data) => ({ data })
      );
    }
  );

  /** Onboarding Control in one call: trial, activation, follow-up, emails, blockers, handoff. */
  app.get<{ Params: { id: string } }>("/accounts/:id/onboarding", { preHandler: readGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
    const accountId = request.params.id;
    const provisioning = (await loadProvisionings(db, ctx.workspaceId, { accountId })).find((p) => p.status === "succeeded");
    if (!provisioning) {
      return reply.status(404).send(copsErrorBody({ code: "NOT_PROVISIONED", message: "The account has no provisioned workspace yet", requestId: ctx.requestId }));
    }
    await ensureActivationInstance(db, ctx.workspaceId, accountId);
    const [activation, followUp, emails, blockers, handoff, integrations] = await Promise.all([
      loadActivation(db, ctx.workspaceId, accountId),
      getFollowUpView(db, ctx.workspaceId, accountId),
      listOnboardingEmails(db, ctx.workspaceId, accountId),
      listBlockers(db, ctx.workspaceId, accountId),
      loadHandoff(db, ctx.workspaceId, accountId),
      loadIntegrations(db, provisioning.provisioned_workspace_id),
    ]);
    const endsAt = provisioning.trial_ends_at ? new Date(provisioning.trial_ends_at) : null;
    return {
      data: {
        account_id: accountId,
        trial_ends_at: provisioning.trial_ends_at,
        trial_days_left: endsAt ? Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000)) : null,
        activation,
        follow_up: followUp,
        emails,
        blockers,
        handoff,
        integrations,
      },
    };
  });

  /** Rep queue (Sales Follow-up screen). owner=all is for managers (crm:admin or onboarding:admin). */
  app.get<{ Querystring: Record<string, string> }>("/follow-up/queue", { preHandler: followUpGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    const parsed = queueSchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    if (parsed.data.owner === "all") {
      const granted = await perms(ctx.workspaceId, ctx.userId);
      if (!["crm:admin", "onboarding:admin"].some((k) => granted.includes(k))) {
        return reply
          .status(403)
          .send(copsErrorBody({ code: "FORBIDDEN", message: "Only managers see every rep's queue", requestId: ctx.requestId, details: { required_permission: "crm:admin" } }));
      }
    }
    return loadFollowUpQueue(db, { workspaceId: ctx.workspaceId, userId: ctx.userId, ...parsed.data });
  });

  /** One-click call / email / meeting / task; always writes a timeline activity. */
  app.post<{ Body: unknown }>(
    "/follow-up/actions",
    { preHandler: followUpGate },
    withCopsIdempotentReply<{ Body: unknown }>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      const parsed = actionSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(
        reply,
        ctx.requestId,
        () => performFollowUpAction(db, ctx, parsed.data, { config: app.config, send: (mail) => sendMail(app.config, mail) }),
        (data) => reply.status(201).send({ data })
      );
    })
  );

  /**
   * Resend email events for onboarding sends (delivered, bounced, opened, clicked). Public path
   * (billing/webhooks prefix); a missing secret or a bad Svix signature is 401.
   */
  app.post("/billing/webhooks/resend/email-events", async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"] as string | undefined);
    const rawBody = (request as { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});
    const h = (name: string) => {
      const v = request.headers[name];
      return Array.isArray(v) ? v[0] : (v as string | undefined);
    };
    const ok = verifySvixSignature(app.config.RESEND_WEBHOOK_SECRET, { id: h("svix-id"), timestamp: h("svix-timestamp"), signature: h("svix-signature") }, rawBody);
    if (!ok) return reply.status(401).send(copsErrorBody({ code: "UNAUTHENTICATED", message: "Invalid webhook signature", requestId }));
    let event: ResendEvent;
    try {
      event = JSON.parse(rawBody) as ResendEvent;
    } catch {
      return reply.status(400).send(copsErrorBody({ code: "VALIDATION_FAILED", message: "Unreadable webhook body", requestId }));
    }
    return { ok: true, outcome: await applyResendEvent(db, event) };
  });

  const adminGate = requireAnyCopsPermission(["admin:admin", "onboarding:admin"], perms);
  const settingsSchema = z.object({ stop_on_critical_escalation: z.boolean(), reason: z.string().trim().min(1, "reason is required").max(1000) }).strict();

  app.get("/onboarding/settings", { preHandler: readGate }, async (request) => ({ data: await getOnboardingSettings(db, request.workspaceId!) }));

  /** Admin-only, audited with a reason (Appendix C "critical escalation if configured"). */
  app.put<{ Body: unknown }>("/onboarding/settings", { preHandler: adminGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    const parsed = settingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    return { data: await setOnboardingSettings(db, ctx, parsed.data) };
  });

  const productEventSchema = z
    .object({
      workspace_id: z.string().regex(UUID, "Invalid id"),
      event_type: z.string().trim().min(1).max(120),
      event_id: z.string().trim().min(1).max(200),
      occurred_at: z.string().datetime({ offset: true }).optional(),
      properties: z.record(z.unknown()).optional(),
    })
    .strict();

  /**
   * Product analytics events (service to service): satisfies activation milestones whose template
   * lists the event type. Bearer INTERNAL_SERVICE_TOKEN; missing token config or a wrong token is 401.
   */
  app.post<{ Body: unknown }>("/internal/product-events", async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const requestId = resolveCorrelationId(request.headers["x-request-id"] as string | undefined);
    const expected = app.config.INTERNAL_SERVICE_TOKEN;
    const given = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const ok = Boolean(expected) && given.length === expected!.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected!));
    if (!ok) return reply.status(401).send(copsErrorBody({ code: "UNAUTHENTICATED", message: "Invalid service token", requestId }));
    const parsed = productEventSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, requestId, parsed.error);
    return { data: await applyProductEvent(db, parsed.data, requestId) };
  });
}
