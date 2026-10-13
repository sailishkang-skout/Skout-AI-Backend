import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "@skout/db";
import { COPS_MODULES, copsErrorBody, copsErrorStatus, resolveCorrelationId, type CopsModule } from "@skout/shared";
import { getConfig } from "./cops-admin-config.service.js";

/**
 * COPS-07 feature flags per module (Bible p.91): one switch per CustomerOps module and workspace,
 * stored as the `feature_flags` admin config. Everything is on until an admin turns a module off.
 * The admin module cannot be turned off, so a workspace can always turn the others back on.
 */
export async function loadCopsModules(db: Db, workspaceId: string): Promise<Record<CopsModule, boolean>> {
  const config = await getConfig(db, workspaceId, "feature_flags", "default");
  const saved = ((config?.value as { modules?: Record<string, unknown> } | undefined)?.modules ?? {}) as Record<string, unknown>;
  const modules = Object.fromEntries(COPS_MODULES.map((m) => [m, saved[m] !== false])) as Record<CopsModule, boolean>;
  modules.admin = true;
  return modules;
}

/**
 * Scope-level preHandler: refuses every route of a module the workspace has turned off. Requests
 * without a workspace (provider webhooks, internal service calls) are not tenant features and pass.
 */
export function requireCopsModule(db: Db, module: CopsModule) {
  return async function copsModuleGate(request: FastifyRequest, reply: FastifyReply) {
    const workspaceId = request.workspaceId;
    if (!workspaceId) return;
    const modules = await loadCopsModules(db, workspaceId);
    if (modules[module]) return;
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    return reply.status(copsErrorStatus("FORBIDDEN")).send(
      copsErrorBody({
        code: "FORBIDDEN",
        message: "This module is turned off for the workspace",
        requestId,
        details: { reason: "module_disabled", module },
      })
    );
  };
}
