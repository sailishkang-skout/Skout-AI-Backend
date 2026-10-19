import type { AutomationGraph, NodeType } from "./automation-graph.js";
import { CONDITION_OPS, CONDITION_TYPES, isGroup, toConditionGroup, type ConditionGroup } from "./automation-nodes/condition.node.js";

/**
 * COPS-10: the safe-action allowlist. A graph may only use these node types (no arbitrary code),
 * and each lists the config keys it cannot run without. Values may be `{{node.field}}` templates
 * filled in at run time, so only presence is checked here; each handler still checks its values.
 */
export const NODE_REQUIRED_CONFIG: Record<NodeType, string[]> = {
  trigger: [],
  condition: [], // checked by checkCondition: a rule group, or the older single rule
  delay: ["seconds"],
  action_http: ["url"],
  action_notification: ["title"],
  action_crm_writeback: ["entityId"],
  action_sequence_enroll: ["sequenceId", "prospectId"],
  action_ai: ["prospectId", "prompt"],
  action_enrichment: ["companyDomain"],
  action_crm_sync: ["entityType", "entityId"],
  approval: ["entityType", "entityId"],
};

export interface GraphIssue {
  path: string;
  message: string;
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * Checks a graph's structure. `strict` (publish) also requires every node's config to be
 * complete; a draft may be half-filled while the admin is still building it.
 */
export function validateAutomationGraph(graph: AutomationGraph, options: { strict: boolean }): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const ids = new Set<string>();

  graph.nodes.forEach((node, i) => {
    const path = `nodes[${i}]`;
    if (ids.has(node.id)) issues.push({ path: `${path}.id`, message: `Duplicate node id ${node.id}` });
    ids.add(node.id);
    const required = NODE_REQUIRED_CONFIG[node.type as NodeType];
    if (!required) {
      issues.push({ path: `${path}.type`, message: `Node type ${node.type} is not allowed` });
      return;
    }
    if (!options.strict) return;
    for (const key of required) {
      if (isMissing(node.config?.[key])) issues.push({ path: `${path}.config.${key}`, message: `${node.type} needs ${key}` });
    }
    if (node.type === "condition") checkCondition(toConditionGroup(node.config ?? {}), `${path}.config`, graph, issues);
    if (node.type === "delay" && !isMissing(node.config.seconds)) {
      const seconds = Number(node.config.seconds);
      if (!Number.isFinite(seconds) || seconds < 0) issues.push({ path: `${path}.config.seconds`, message: "Delay must be zero or more seconds" });
    }
  });

  graph.edges.forEach((edge, i) => {
    const path = `edges[${i}]`;
    if (!ids.has(edge.source)) issues.push({ path: `${path}.source`, message: `Unknown node ${edge.source}` });
    if (!ids.has(edge.target)) issues.push({ path: `${path}.target`, message: `Unknown node ${edge.target}` });
    const source = graph.nodes.find((n) => n.id === edge.source);
    if (options.strict && source?.type === "condition" && !edge.branch) {
      issues.push({ path: `${path}.branch`, message: "An edge out of a condition needs a true or false branch" });
    }
  });

  if (options.strict) {
    if (graph.nodes.length === 0) issues.push({ path: "nodes", message: "A workflow needs at least one node" });
    if (hasCycle(graph)) issues.push({ path: "edges", message: "A workflow cannot loop back on itself" });
  }
  return issues;
}

const OPS = new Set<string>(CONDITION_OPS);
const TYPES = new Set<string>(CONDITION_TYPES);
const NO_VALUE_OPS = new Set(["exists", "not_exists"]);

function checkCondition(group: ConditionGroup, path: string, graph: AutomationGraph, issues: GraphIssue[]) {
  if (group.match !== "all" && group.match !== "any") issues.push({ path: `${path}.match`, message: "A condition group matches all or any" });
  if (!group.rules.length) issues.push({ path: `${path}.rules`, message: "A condition group needs at least one rule" });
  group.rules.forEach((rule, i) => {
    const p = `${path}.rules[${i}]`;
    if (isGroup(rule)) return checkCondition(rule, p, graph, issues);
    if (isMissing(rule.sourceNodeId) || !graph.nodes.some((n) => n.id === rule.sourceNodeId)) {
      issues.push({ path: `${p}.sourceNodeId`, message: "A rule must read an earlier step" });
    }
    if (isMissing(rule.field)) issues.push({ path: `${p}.field`, message: "A rule needs a field" });
    if (!OPS.has(rule.op)) issues.push({ path: `${p}.op`, message: `Operator ${String(rule.op)} is not allowed` });
    if (rule.type !== undefined && !TYPES.has(rule.type)) issues.push({ path: `${p}.type`, message: `Type ${String(rule.type)} is not allowed` });
    if (!NO_VALUE_OPS.has(rule.op) && rule.value === undefined) issues.push({ path: `${p}.value`, message: "A rule needs a value to compare with" });
  });
}

function hasCycle(graph: AutomationGraph): boolean {
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === "visiting") return true;
    if (s === "done") return false;
    state.set(id, "visiting");
    for (const e of graph.edges) if (e.source === id && visit(e.target)) return true;
    state.set(id, "done");
    return false;
  };
  return graph.nodes.some((n) => visit(n.id));
}
