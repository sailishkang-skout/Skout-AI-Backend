import type { NodeHandler } from "./types.js";

/**
 * Config: { seconds: number }. The wait itself is done by the run worker (COPS-10): the first
 * claim stores run_after on the step and hands it back, and the step is claimed again only once it
 * is due. This handler runs at that point, so it just records the delay.
 */
export const delayNodeHandler: NodeHandler = async (ctx) => {
  const { seconds } = ctx.node.config as { seconds: number };
  return { output: { delayedSeconds: seconds } };
};
