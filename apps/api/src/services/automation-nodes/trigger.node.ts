import type { NodeHandler } from "./types.js";

/**
 * A trigger node is the graph's visual entry point (how a run starts), not something with its
 * own side effect to run — automationRunSteps still creates a pending step for it via
 * findStartNodes(), so it needs a registered handler, but it's a no-op: its outgoing edges lead
 * to the first real node.
 */
export const triggerNodeHandler: NodeHandler = async () => {
  return { output: {} };
};
