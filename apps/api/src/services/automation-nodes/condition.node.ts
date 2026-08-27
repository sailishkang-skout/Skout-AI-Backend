import type { NodeHandler } from "./types.js";

/** Config: { sourceNodeId: string; field: string; op: "equals" | "not_equals"; value: unknown } */
export const conditionNodeHandler: NodeHandler = async (ctx) => {
  const { sourceNodeId, field, op, value } = ctx.node.config as {
    sourceNodeId: string;
    field: string;
    op: "equals" | "not_equals";
    value: unknown;
  };
  const source = (ctx.priorOutputs[sourceNodeId] ?? {}) as Record<string, unknown>;
  const actual = source[field];
  const matches = op === "equals" ? actual === value : actual !== value;
  return { output: { actual, matches }, branch: matches ? "true" : "false" };
};
