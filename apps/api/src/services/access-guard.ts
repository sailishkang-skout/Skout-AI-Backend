import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "@skout/db";
import { loadWorkspaceAccess } from "@skout/auth";
import { FEATURE_LABELS, featureForApiPath } from "@skout/shared";
import type { Env } from "../config/env.js";
import { earlyAccessGateEnabled } from "../config/early-access.js";
import { apiError } from "../utils/http.js";
import { isMeteredAi } from "../routes/cops-usage.routes.js";

/** What a workspace that is not active yet may still call: sign-in, its own request, health. */
export const ACCESS_ALLOWLIST = ["auth", "access-request", "health", "me", "jwks", ".well-known"] as const;

function decodedUrl(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

function firstSegment(url: string): string {
  const path = url.split("?")[0] ?? "";
  return path.replace(/^\/api\/v1\//, "").split("/")[0] ?? "";
}

/**
 * Early access guard (spec 2026-11-17), registered on the /api/v1 scope after auth has set
 * request.workspaceId. A workspace that is not active gets 403 access_pending / access_rejected on
 * everything but the allowlist; a route whose feature switch is off gets 403 feature_disabled.
 * Requests without a workspace (provider webhooks, internal services) are not tenant traffic and pass.
 */
export function accessGuard(db: Db, config: Pick<Env, "NODE_ENV"> & { EARLY_ACCESS_GATE_ENABLED?: "true" | "false" }) {
  return async function earlyAccessGuard(request: FastifyRequest, reply: FastifyReply) {
    const workspaceId = request.workspaceId;
    if (!workspaceId) return;
    const access = await loadWorkspaceAccess(db, workspaceId);

    if (access.status !== "active" && earlyAccessGateEnabled(config)) {
      if ((ACCESS_ALLOWLIST as readonly string[]).includes(firstSegment(decodedUrl(request.url)))) return;
      const rejected = access.status === "rejected";
      return reply
        .code(403)
        .send(
          apiError(
            rejected ? "access_rejected" : "access_pending",
            rejected ? "This workspace doesn't have access to Skout." : "This workspace is waiting for early access approval.",
            403
          )
        );
    }

    // The matched route pattern, not the raw URL: the router decodes "/%73equences" to /sequences, so
    // matching the raw URL would let an encoded path dodge a switch. Metered AI actions outside /ai
    // (account recommendations) belong to the ai switch too.
    const feature =
      featureForApiPath(request.routeOptions?.url ?? request.url) ?? (isMeteredAi(request.method, decodedUrl(request.url)) ? "ai" : null);
    if (feature && !access.features[feature]) {
      return reply
        .code(403)
        .send({ ...apiError("feature_disabled", `${FEATURE_LABELS[feature]} isn't included in this workspace's plan.`, 403, { feature }), feature });
    }
  };
}
