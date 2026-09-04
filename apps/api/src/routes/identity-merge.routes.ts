import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema, scopedById } from "@skout/db";
import { z } from "zod";
import {
  listPendingMergeProposals,
  proposeMerge,
  resolveMergeProposal,
  reverseMergeEvent,
} from "../services/identity-merge.service.js";
import { applyIdentityMerge, restoreIdentityMerge } from "../services/identity-merge-apply.service.js";
import { recordPrivilegedAction, enforcePermission, assertStepUp } from "@skout/auth";
import { errorResponse } from "../utils/http.js";

const candidateSchema = z.object({
  name: z.string().optional(),
  domain: z.string().optional(),
  title: z.string().optional(),
  location: z.string().optional(),
});

const proposeSchema = z.object({
  entityType: z.string().min(1),
  leftEntityId: z.string().min(1),
  rightEntityId: z.string().min(1),
  left: candidateSchema,
  right: candidateSchema,
});

const resolveSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  beforeSnapshot: z.unknown().optional(),
});

/**
 * §5.2 — probabilistic identity-merge proposals. Scoring/proposal creation is open to any
 * workspace member (it never merges anything by itself); approving or rejecting a proposal —
 * the step that actually leads to a merge — is gated to owner/admin, matching the same
 * role bar used for other high-consequence actions in this API (see team.routes.ts).
 */
export async function identityMergeRoutes(app: FastifyInstance) {
  app.post("/identity-merge/proposals", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));

    const parsed = proposeSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid proposal payload", 400, parsed.error.flatten()));
    }

    const proposal = await proposeMerge(app.db, { workspaceId: request.workspaceId, ...parsed.data });
    if (!proposal) {
      return reply.send({ data: null, message: "Candidates did not clear the merge-proposal confidence threshold." });
    }
    return reply.code(201).send({ data: proposal });
  });

  app.get("/identity-merge/proposals", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!app.db) return reply.send({ data: [], total: 0 });

    const data = await listPendingMergeProposals(app.db, request.workspaceId);
    return reply.send({ data, total: data.length });
  });

  app.post<{ Params: { id: string } }>("/identity-merge/proposals/:id/resolve", async (request, reply) => {
    if (!request.workspaceId || !request.userId || !request.role) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    if (!["owner", "admin"].includes(request.role)) {
      return reply.code(403).send(errorResponse("Forbidden", 403, { requiredRoles: ["owner", "admin"] }));
    }
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));

    // §5.1 / §11.1 — fine-grained RBAC check running alongside the role gate above. The role
    // gate above is what actually enforces access today (unchanged); this call is shadow-mode
    // by default (RBAC_ENFORCEMENT_ENABLED unset) — see enforcePermission's own doc comment for
    // why enforcing here before backfill-rbac.ts has run would deny every request outright.
    await enforcePermission(app.db, request.workspaceId, request.userId, "identity:review_merges", {
      enforce: app.config.RBAC_ENFORCEMENT_ENABLED,
      onShadowDeny: (info) =>
        app.log.warn(info, "RBAC shadow-mode: identity:review_merges would have been denied (resolve)"),
    });

    // §11.1 — step-up re-authentication for this privileged action. Gated behind
    // STEP_UP_ENFORCEMENT_ENABLED (default off) so this only starts blocking requests once an
    // operator has confirmed the frontend actually calls POST /auth/step-up before hitting this
    // route; STEP_UP_SIGNING_SECRET must also be set (see step-up.routes.ts).
    if (app.config.STEP_UP_ENFORCEMENT_ENABLED) {
      if (!app.config.STEP_UP_SIGNING_SECRET) {
        return reply.code(503).send(errorResponse("Step-up re-authentication is not configured", 503));
      }
      assertStepUp(request.headers, app.config.STEP_UP_SIGNING_SECRET, request.userId);
    }

    const parsed = resolveSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid resolution payload", 400, parsed.error.flatten()));
    }

    let beforeSnapshot = parsed.data.beforeSnapshot;
    if (parsed.data.decision === "approved") {
      const [proposal] = await app.db
        .select()
        .from(schema.identityMergeProposals)
        .where(
          scopedById(schema.identityMergeProposals, request.workspaceId, request.params.id)
        )
        .limit(1);
      if (!proposal) return reply.status(404).send(errorResponse("Proposal not found", 404));
      if (proposal.status !== "pending") {
        return reply.status(409).send(errorResponse("Proposal already resolved", 409, { status: proposal.status }));
      }

      beforeSnapshot = await applyIdentityMerge(
        app.db,
        request.workspaceId,
        proposal.entityType,
        proposal.leftEntityId,
        proposal.rightEntityId
      );
    }

    const updated = await resolveMergeProposal(app.db, {
      workspaceId: request.workspaceId,
      proposalId: request.params.id,
      reviewerId: request.userId,
      decision: parsed.data.decision,
      beforeSnapshot,
    });

    // §11.1 — audit event for a privileged action. Never lets an audit-write failure block a
    // resolution that already succeeded; logs instead of swallowing silently (§3's "no silent
    // failure" principle).
    try {
      await recordPrivilegedAction(app.db, {
        workspaceId: request.workspaceId,
        actorId: request.userId,
        action: "identity_merge.resolve",
        entityType: "identity_merge_proposal",
        entityId: request.params.id,
        afterState: { decision: parsed.data.decision },
      });
    } catch (err) {
      app.log.error({ err }, "Failed to record privileged-action audit event for identity_merge.resolve");
    }

    return reply.send({ data: updated });
  });

  app.post<{ Params: { id: string } }>("/identity-merge/events/:id/reverse", async (request, reply) => {
    if (!request.workspaceId || !request.userId || !request.role) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    if (!["owner", "admin"].includes(request.role)) {
      return reply.code(403).send(errorResponse("Forbidden", 403, { requiredRoles: ["owner", "admin"] }));
    }
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));

    // §5.1 / §11.1 — same shadow-mode RBAC check as the resolve route above.
    await enforcePermission(app.db, request.workspaceId, request.userId, "identity:review_merges", {
      enforce: app.config.RBAC_ENFORCEMENT_ENABLED,
      onShadowDeny: (info) =>
        app.log.warn(info, "RBAC shadow-mode: identity:review_merges would have been denied (reverse)"),
    });

    // §11.1 — same step-up gate as the resolve route above.
    if (app.config.STEP_UP_ENFORCEMENT_ENABLED) {
      if (!app.config.STEP_UP_SIGNING_SECRET) {
        return reply.code(503).send(errorResponse("Step-up re-authentication is not configured", 503));
      }
      assertStepUp(request.headers, app.config.STEP_UP_SIGNING_SECRET, request.userId);
    }

    const beforeSnapshot = await reverseMergeEvent(app.db, request.workspaceId, request.params.id, request.userId);
    await restoreIdentityMerge(app.db, request.workspaceId, beforeSnapshot);

    try {
      await recordPrivilegedAction(app.db, {
        workspaceId: request.workspaceId,
        actorId: request.userId,
        action: "identity_merge.reverse",
        entityType: "identity_merge_event",
        entityId: request.params.id,
        afterState: { beforeSnapshot },
      });
    } catch (err) {
      app.log.error({ err }, "Failed to record privileged-action audit event for identity_merge.reverse");
    }

    return reply.send({ data: { beforeSnapshot }, message: "Merge reversed and underlying records restored." });
  });
}
