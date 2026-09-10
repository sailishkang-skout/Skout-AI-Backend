import type { NodeHandler } from "./types.js";

/**
 * String-compares both sides rather than `===` — the config panel's Value field is always a
 * plain text input, so a number-typed prior output (e.g. an HTTP status code) would otherwise
 * never strictly-equal the string the user typed, and the condition would silently always take
 * the false branch.
 */
function looseEquals(actual: unknown, expected: unknown): boolean {
  if (actual === undefined || actual === null) return expected === actual;
  return String(actual) === String(expected);
}

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
  const equal = looseEquals(actual, value);
  const matches = op === "equals" ? equal : !equal;
  return { output: { actual, matches }, branch: matches ? "true" : "false" };
};
