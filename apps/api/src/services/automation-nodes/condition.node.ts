import type { NodeHandler } from "./types.js";

/**
 * COPS-10 conditions: AND/OR groups of typed rules. A rule reads `field` (a dot path) from an
 * earlier step's output and compares it to `value` as `type`. The older single-rule config
 * ({ sourceNodeId, field, op: "equals" | "not_equals", value }) still works: it is a one-rule
 * "all" group compared as text.
 */
export const CONDITION_OPS = ["equals", "not_equals", "gt", "gte", "lt", "lte", "contains", "not_contains", "in", "not_in", "exists", "not_exists"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export const CONDITION_TYPES = ["string", "number", "date", "boolean"] as const;
export type ConditionValueType = (typeof CONDITION_TYPES)[number];

export interface ConditionRule {
  sourceNodeId: string;
  field: string;
  op: ConditionOp;
  value?: unknown;
  type?: ConditionValueType;
}
export interface ConditionGroup {
  match: "all" | "any";
  rules: (ConditionRule | ConditionGroup)[];
}

export interface RuleResult {
  sourceNodeId: string;
  field: string;
  op: ConditionOp;
  value: unknown;
  actual: unknown;
  matched: boolean;
}

export function isGroup(x: unknown): x is ConditionGroup {
  return typeof x === "object" && x !== null && Array.isArray((x as ConditionGroup).rules);
}

/** The condition config as a group, whichever shape was saved. */
export function toConditionGroup(config: Record<string, unknown>): ConditionGroup {
  if (isGroup(config)) return config as unknown as ConditionGroup;
  const { sourceNodeId, field, op, value } = config as unknown as ConditionRule;
  return { match: "all", rules: [{ sourceNodeId, field, op, value, type: "string" }] };
}

function readPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), source);
}

/** Casts to the rule's type; undefined when the value cannot be read as that type. */
function cast(raw: unknown, type: ConditionValueType): string | number | boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  switch (type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      return String(raw).trim() === "" || !Number.isFinite(n) ? undefined : n;
    }
    case "date": {
      const t = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
      return Number.isNaN(t) ? undefined : t;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      const s = String(raw).trim().toLowerCase();
      return s === "true" ? true : s === "false" ? false : undefined;
    }
    default:
      return String(raw);
  }
}

function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function evaluateRule(rule: ConditionRule, actual: unknown): boolean {
  const type = rule.type ?? "string";
  if (rule.op === "exists") return actual !== undefined && actual !== null && actual !== "";
  if (rule.op === "not_exists") return !(actual !== undefined && actual !== null && actual !== "");
  const a = cast(actual, type);
  if (rule.op === "in" || rule.op === "not_in") {
    const hit = a !== undefined && listOf(rule.value).some((v) => cast(v, type) === a);
    return rule.op === "in" ? hit : !hit;
  }
  const b = cast(rule.value, type);
  switch (rule.op) {
    case "equals":
      return a === b;
    case "not_equals":
      return a !== b;
    case "contains":
    case "not_contains": {
      const hit = a !== undefined && b !== undefined && String(a).toLowerCase().includes(String(b).toLowerCase());
      return rule.op === "contains" ? hit : !hit;
    }
    default: {
      // gt / gte / lt / lte: an unreadable side never matches.
      if (a === undefined || b === undefined) return false;
      if (rule.op === "gt") return a > b;
      if (rule.op === "gte") return a >= b;
      if (rule.op === "lt") return a < b;
      return a <= b;
    }
  }
}

export function evaluateGroup(group: ConditionGroup, priorOutputs: Record<string, unknown>, results: RuleResult[]): boolean {
  const outcomes = group.rules.map((r) => {
    if (isGroup(r)) return evaluateGroup(r, priorOutputs, results);
    const actual = readPath(priorOutputs[r.sourceNodeId], r.field);
    const matched = evaluateRule(r, actual);
    results.push({ sourceNodeId: r.sourceNodeId, field: r.field, op: r.op, value: r.value, actual, matched });
    return matched;
  });
  return group.match === "any" ? outcomes.some(Boolean) : outcomes.every(Boolean);
}

/** Records each rule's result on the step (the run's "matched conditions") and picks the branch. */
export const conditionNodeHandler: NodeHandler = async (ctx) => {
  const results: RuleResult[] = [];
  const matches = evaluateGroup(toConditionGroup(ctx.node.config), ctx.priorOutputs, results);
  const first = results[0];
  return {
    output: { matches, rules: results, ...(results.length === 1 && first ? { actual: first.actual } : {}) },
    branch: matches ? "true" : "false",
  };
};
