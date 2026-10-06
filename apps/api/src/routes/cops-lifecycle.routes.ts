import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import {
  appendCopsEvent,
  applyCopsTransition,
  COPS_DIMENSIONS,
  COPS_STATES,
  copsErrorBody,
  copsErrorStatus,
  createCopsEvent,
  resolveCorrelationId,
  type CopsDimension,
  type CopsResource,
} from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { requireWorkspaceId } from "../utils/http.js";
import {
  copsIdempotencyStore,
  requireCopsPermission,
  writeCopsAudit,
} from "../services/cops-platform.service.js";
import { withCopsIdempotency } from "../services/cops-idempotent.js";

const { copsLifecycleStates } = schema;

const INITIAL_STATE: Record<CopsDimension, string> = {
  opportunity: "qualified",
  commercial: "proposal_sent",
  onboarding: "not_started",
  account: "trial",
  health: "healthy",
  support: "no_issue",
};

const PERMISSION_RESOURCE: Record<CopsDimension, CopsResource> = {
  opportunity: "crm",
  commercial: "commercial",
  onboarding: "onboarding",
  account: "crm",
  health: "analytics",
  support: "tickets",
};

export const COPS_LIFECYCLE_PARAMS_SCHEMA = z.object({
  dimension: z.enum(COPS_DIMENSIONS),
  entityId: z.string().uuid(),
});

export const COPS_LIFECYCLE_BODY_SCHEMA = z.object({
  to: z.string().min(1),
  source: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(500),
}).strict();

export async function copsLifecycleRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const idempotency = copsIdempotencyStore(db);

  app.post<{ Params: { dimension: string; entityId: string } }>(
    "/cops/lifecycle/:dimension/:entityId/transitions",
    {
      preHandler: async (request, reply) => {
        const params = COPS_LIFECYCLE_PARAMS_SCHEMA.safeParse(request.params);
        if (!params.success) {
          const requestId = resolveCorrelationId(request.headers["x-request-id"]);
          return reply.status(422).send(
            copsErrorBody({
              code: "VALIDATION_FAILED",
              message: "Invalid lifecycle transition path",
              requestId,
              details: {
                fields: params.error.issues.map((issue) => ({
                  path: issue.path.join("."),
                  code: issue.code,
                  message: issue.message,
                })),
              },
            })
          );
        }
        return requireCopsPermission(PERMISSION_RESOURCE[params.data.dimension], "write", (workspaceId, userId) =>
          getMemberPermissions(db, workspaceId, userId)
        )(request, reply);
      },
    },
    withCopsIdempotency(idempotency, async (request) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const parsedParams = COPS_LIFECYCLE_PARAMS_SCHEMA.safeParse(request.params);
      const parsedBody = COPS_LIFECYCLE_BODY_SCHEMA.safeParse(request.body);
      if (!parsedParams.success || !parsedBody.success) {
        const issues = [
          ...(parsedParams.success ? [] : parsedParams.error.issues),
          ...(parsedBody.success ? [] : parsedBody.error.issues),
        ];
        return {
          status: copsErrorStatus("VALIDATION_FAILED"),
          body: copsErrorBody({
            code: "VALIDATION_FAILED",
            message: "Invalid lifecycle transition",
            requestId,
            details: {
              fields: issues.map((issue) => ({
                path: issue.path.join("."),
                code: issue.code,
                message: issue.message,
              })),
            },
          }),
        };
      }

      const { dimension, entityId } = parsedParams.data;
      const body = parsedBody.data;
      const validStates: readonly string[] = COPS_STATES[dimension];
      if (!validStates.includes(body.to)) {
        return {
          status: copsErrorStatus("VALIDATION_FAILED"),
          body: copsErrorBody({
            code: "VALIDATION_FAILED",
            message: "Unknown target state for lifecycle dimension",
            requestId,
            details: { fields: [{ path: "to", code: "invalid_state", message: `Expected one of: ${validStates.join(", ")}` }] },
          }),
        };
      }

      const workspaceId = requireWorkspaceId(request);
      const actorId = request.userId!;
      const occurredAt = new Date();
      try {
        const result = await db.transaction(async (tx) => {
          await tx
            .insert(copsLifecycleStates)
            .values({ workspaceId, dimension, entityId, state: INITIAL_STATE[dimension] })
            .onConflictDoNothing();

          const [current] = await tx
            .select()
            .from(copsLifecycleStates)
            .where(
              and(
                eq(copsLifecycleStates.workspaceId, workspaceId),
                eq(copsLifecycleStates.dimension, dimension),
                eq(copsLifecycleStates.entityId, entityId)
              )
            )
            .for("update")
            .limit(1);
          if (!current) throw new Error("Lifecycle state row missing after initialization");

          const transition = applyCopsTransition({
            dimension,
            from: current.state,
            to: body.to,
            actor: { type: "user", id: actorId },
            source: body.source,
            reason: body.reason,
            at: occurredAt,
          });
          await tx
            .update(copsLifecycleStates)
            .set({ state: transition.to, updatedAt: transition.at })
            .where(
              and(
                eq(copsLifecycleStates.workspaceId, workspaceId),
                eq(copsLifecycleStates.dimension, dimension),
                eq(copsLifecycleStates.entityId, entityId)
              )
            );

          await writeCopsAudit(tx, {
            tenantId: workspaceId,
            actor: transition.actor,
            entityType: `cops_${dimension}`,
            entityId,
            action: "lifecycle.transitioned",
            before: { state: transition.from },
            after: { state: transition.to },
            reason: transition.reason,
            correlationId: requestId,
            sourceChannel: body.source === "web" ? "web" : "api",
            occurredAt: transition.at,
          });

          const event = createCopsEvent({
            eventType: "LifecycleTransitioned",
            tenantId: workspaceId,
            aggregateType: dimension,
            aggregateId: entityId,
            actor: transition.actor,
            correlationId: requestId,
            payload: {
              dimension,
              entity_id: entityId,
              from: transition.from,
              to: transition.to,
              source: transition.source,
              reason: transition.reason,
            },
            occurredAt: transition.at,
          });
          await appendCopsEvent(tx as never, event);
          return transition;
        });

        return { status: 200, body: { data: result, request_id: requestId } };
      } catch (err) {
        if (err instanceof Error && err.name === "CopsIllegalTransitionError") {
          const transitionError = err as Error & { dimension: string; from: string; to: string; allowed: string[] };
          return {
            status: 409,
            body: copsErrorBody({
              code: "BUSINESS_STATE_CONFLICT",
              message: transitionError.message,
              requestId,
              details: {
                dimension: transitionError.dimension,
                current_state: { state: transitionError.from },
                requested_state: transitionError.to,
                allowed_transitions: transitionError.allowed,
              },
            }),
          };
        }
        throw err;
      }
    })
  );
}
