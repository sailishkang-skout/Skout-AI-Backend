import type { FastifyReply, FastifyRequest } from "fastify";
import type { WorkspaceAccessState } from "@skout/auth";
import { apiError } from "../utils/http.js";

/** Same rule as Skout-AI-Backend apps/api config/early-access.ts: on in production unless overridden. */
export function earlyAccessGateEnabled(config: { NODE_ENV: string; EARLY_ACCESS_GATE_ENABLED?: "true" | "false" }): boolean {
  if (config.EARLY_ACCESS_GATE_ENABLED) return config.EARLY_ACCESS_GATE_ENABLED === "true";
  return config.NODE_ENV === "production";
}

/**
 * Early access for the CRM service (spec 2026-11-17): a workspace that is not active yet, or whose
 * `crm` feature switch is off, gets 403 on every CRM route. Requests without a workspace (health,
 * internal service calls) pass.
 */
/** CRM's apiError has no `code`; the customer app reads `code`, as from the main API. */
const refuse = (code: string, message: string, extra?: Record<string, unknown>) => ({ ...apiError(code, message, 403, extra), code });

export function crmAccessGuard(load: (workspaceId: string) => Promise<WorkspaceAccessState>, gateEnabled: boolean) {
  return async function crmEarlyAccessGuard(request: FastifyRequest, reply: FastifyReply) {
    const workspaceId = request.workspaceId;
    if (!workspaceId) return;
    const access = await load(workspaceId);
    if (access.status !== "active" && gateEnabled) {
      const rejected = access.status === "rejected";
      return reply
        .code(403)
        .send(
          refuse(
            rejected ? "access_rejected" : "access_pending",
            rejected ? "This workspace doesn't have access to Skout." : "This workspace is waiting for early access approval."
          )
        );
    }
    if (!access.features.crm) {
      return reply.code(403).send(refuse("feature_disabled", "CRM isn't included in this workspace's plan.", { feature: "crm" }));
    }
  };
}
