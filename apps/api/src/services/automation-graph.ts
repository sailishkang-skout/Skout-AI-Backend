export type NodeType =
  | "trigger"
  | "condition"
  | "delay"
  | "action_http"
  | "action_notification"
  | "action_crm_writeback"
  | "action_sequence_enroll"
  | "approval";

export interface AutomationNode {
  id: string;
  type: NodeType;
  /** Node-type-specific config — validated by each node handler, not here. */
  config: Record<string, unknown>;
}

export interface AutomationEdge {
  id: string;
  source: string;
  target: string;
  /** Set only on edges out of a "condition" node. */
  branch?: "true" | "false";
}

export interface AutomationGraph {
  nodes: AutomationNode[];
  edges: AutomationEdge[];
}

/** Nodes with no incoming edge — where a run starts. */
export function findStartNodes(graph: AutomationGraph): AutomationNode[] {
  const targets = new Set(graph.edges.map((e) => e.target));
  return graph.nodes.filter((n) => !targets.has(n.id));
}

/** Outgoing edges from a node, optionally filtered to one condition branch. */
export function nextNodeIds(graph: AutomationGraph, nodeId: string, branch?: "true" | "false"): string[] {
  return graph.edges
    .filter((e) => e.source === nodeId && (branch === undefined || e.branch === branch))
    .map((e) => e.target);
}
