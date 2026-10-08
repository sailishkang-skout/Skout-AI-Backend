import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@skout/db";
import { copsErrorBody, copsErrorStatus, isValidIdempotencyKey, resolveCorrelationId } from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { requireAnyCopsPermission } from "../services/cops-platform.service.js";
import type { CopsCapturingReply } from "../services/cops-idempotent.js";
import {
  defaultOnboardingDeps,
  listOnboardingEmails,
  OnboardingError,
  previewOnboardingEmail,
  sendOnboardingEmail,
  type OnboardingDeps,
} from "../services/cops-onboarding.service.js";
import { getFollowUpView } from "../services/cops-follow-up.service.js";
import { ActivationError, completeManualMilestone, ensureActivationInstance, loadActivation } from "../services/cops-activation.service.js";
import { loadProvisionings } from "../services/cops-provisioning.service.js";
import { listBlockers, loadHandoff } from "../services/cops-onboarding-signals.service.js";
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
    const [activation, followUp, emails, blockers, handoff] = await Promise.all([
      loadActivation(db, ctx.workspaceId, accountId),
      getFollowUpView(db, ctx.workspaceId, accountId),
      listOnboardingEmails(db, ctx.workspaceId, accountId),
      listBlockers(db, ctx.workspaceId, accountId),
      loadHandoff(db, ctx.workspaceId, accountId),
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
      },
    };
  });
}
