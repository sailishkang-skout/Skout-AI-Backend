import type { NodeHandler } from "./types.js";

/**
 * Config: { seconds: number }. Executes synchronously — the worker is responsible for not
 * re-claiming this step until nextRetryAt if the caller wants an async delay; for MVP this
 * handler just returns immediately with the delay recorded, since the queue's own poll interval
 * already bounds how "live" any given step advance is.
 */
export const delayNodeHandler: NodeHandler = async (ctx) => {
  const { seconds } = ctx.node.config as { seconds: number };
  return { output: { delayedSeconds: seconds } };
};
