import type { NodeHandler } from "./types.js";

/**
 * A trigger node is the graph's visual entry point (how a run starts), not something with its
 * own side effect to run — automationRunSteps still creates a pending step for it via
 * findStartNodes(), so it needs a registered handler, but it's a no-op: its outgoing edges lead
 * to the first real node.
 */
export const triggerNodeHandler: NodeHandler = async (ctx) => {
  // COPS-10: the trigger's output is the run's trigger payload, so later steps and conditions can
  // read it as `{{<trigger node id>.field}}`.
  return { output: { ...(ctx.triggerPayload ?? {}) } };
};
