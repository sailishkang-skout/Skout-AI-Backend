import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "@skout/db";
import type { Env } from "../../config/env.js";
import { buildEntitlementsService } from "../entitlements.service.js";
import { requireWorkspaceId } from "../../utils/http.js";

/**
 * ENR-06 — the internal-only release flag for the LinkedIn enrichment feature (capture,
 * research, provider jobs, campaigns).
 *
 * The feature is "internal" until Legal and Product have approved LinkedIn data use and the
 * vendor terms. That approval is recorded by setting ENRICHMENT_LEGAL_APPROVAL_REF to the
 * reference of the sign-off (see docs/ops/enrichment-release-gates.md); asking for
 * ENRICHMENT_RELEASE_STAGE=general without it leaves the feature internal.
 *
 * While internal, a production workspace can use the feature only when it has been given the
 * `enrichment.internal_access` entitlement. Outside production the gate is not enforced, so
 * development and test environments work without per-workspace setup.
 */

export const INTERNAL_ACCESS_ENTITLEMENT = "enrichment.internal_access";

type GateConfig = Pick<Env, "NODE_ENV" | "ENRICHMENT_RELEASE_STAGE" | "ENRICHMENT_LEGAL_APPROVAL_REF">;

export interface ReleaseState {
  /** What the deployment asked for. */
  requestedStage: "internal" | "general";
  /** What is in effect: "general" only with a recorded approval. */
  stage: "internal" | "general";
  legalApprovalRecorded: boolean;
  /** False outside production, where every workspace has access. */
  enforced: boolean;
}

export function releaseState(config: GateConfig): ReleaseState {
  const legalApprovalRecorded = Boolean(config.ENRICHMENT_LEGAL_APPROVAL_REF?.trim());
  const requestedStage = config.ENRICHMENT_RELEASE_STAGE;
  return {
    requestedStage,
    stage: requestedStage === "general" && legalApprovalRecorded ? "general" : "internal",
    legalApprovalRecorded,
    enforced: config.NODE_ENV === "production",
  };
}

export interface WorkspaceAccess extends ReleaseState {
  enabled: boolean;
  /** Why the workspace cannot use the feature; null when it can. */
  reason: string | null;
}

export async function workspaceReleaseAccess(db: Db, config: GateConfig, workspaceId: string): Promise<WorkspaceAccess> {
  const state = releaseState(config);
  if (!state.enforced || state.stage === "general") return { ...state, enabled: true, reason: null };
  const granted = await buildEntitlementsService(db)!.getValueOr<unknown>(workspaceId, INTERNAL_ACCESS_ENTITLEMENT, false);
  return granted === true
    ? { ...state, enabled: true, reason: null }
    : { ...state, enabled: false, reason: "LinkedIn enrichment is in internal release and is not enabled for this workspace." };
}

async function refuseUnreleased(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  if (!app.db) return undefined;
  let workspaceId: string;
  try {
    workspaceId = requireWorkspaceId(request);
  } catch {
    // No workspace on the request: the route's own authorization answers that.
    return undefined;
  }
  const access = await workspaceReleaseAccess(app.db, app.config, workspaceId);
  if (access.enabled) return undefined;
  return reply.status(403).send({ ok: false, error: access.reason, code: "enrichment_not_released", stage: access.stage });
}

/** Puts every route of a plugin behind the release flag. Call first inside the plugin. */
export function guardWithReleaseGate(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => refuseUnreleased(app, request, reply));
}

/** For a single route in a plugin that also serves routes outside the feature. */
export async function assertReleased(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  return (await refuseUnreleased(app, request, reply)) === undefined;
}

/** Logged once at start-up so a mis-set stage is visible in the deploy log. */
export function describeRelease(config: GateConfig): { level: "info" | "warn"; message: string; state: ReleaseState } {
  const state = releaseState(config);
  if (state.requestedStage === "general" && !state.legalApprovalRecorded) {
    return { level: "warn", message: "ENRICHMENT_RELEASE_STAGE=general ignored: ENRICHMENT_LEGAL_APPROVAL_REF is not set. Enrichment stays internal.", state };
  }
  return { level: "info", message: `LinkedIn enrichment release stage: ${state.stage}${state.enforced ? "" : " (not enforced outside production)"}`, state };
}
