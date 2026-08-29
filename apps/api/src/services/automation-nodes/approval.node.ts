import { assertAllowed } from "../policy-gateway.service.js";
import type { NodeHandler } from "./types.js";

/**
 * Config: { entityType: string; entityId: string }. Pauses the run for human sign-off via the
 * existing Policy Gateway rather than inventing a bespoke approval mechanism — a denied/proposed
 * outcome throws HttpError(403|409), which the worker catches and uses to move the run to
 * "awaiting_approval" instead of "failed".
 */
export const approvalNodeHandler: NodeHandler = async (ctx) => {
  const { entityType, entityId } = ctx.node.config as { entityType: string; entityId: string };

  if (ctx.isSimulation) {
    return { output: { simulated: true, entityType, entityId } };
  }

  const result = await assertAllowed(ctx.db, {
    workspaceId: ctx.workspaceId,
    actionKey: "workflow.step_approval",
    entityType,
    entityId,
  });
  return { output: { decisionId: result.decisionId, mode: result.mode, outcome: result.outcome } };
};
