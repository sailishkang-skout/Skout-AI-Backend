import type { Db } from "@skout/db";
import type { Env } from "../../config/env.js";
import type { AutomationNode } from "../automation-graph.js";

export interface NodeExecutionContext {
  db: Db;
  config: Env;
  workspaceId: string;
  runId: string;
  isSimulation: boolean;
  node: AutomationNode;
  /** Outputs of every previously-succeeded step in this run, keyed by nodeId. */
  priorOutputs: Record<string, unknown>;
}

export interface NodeHandlerResult {
  output: Record<string, unknown>;
  /** Only "condition" nodes set this — which branch to continue on. */
  branch?: "true" | "false";
  /** Set when the node's own outcome is genuinely ambiguous (e.g. a request timeout or 5xx with
   * no confirmed delivery) — the caller routes this to execution-intent's outcome_unknown state
   * instead of a clean success or a normal retryable failure. */
  outcome?: "ambiguous";
}

/** Thrown by a node handler to signal an ambiguous (not cleanly failed) outcome — distinct from
 * a normal thrown Error, which the worker treats as a clean, retryable/terminal failure. */
export class AmbiguousOutcomeError extends Error {
  readonly outcome = "ambiguous" as const;
}

export type NodeHandler = (ctx: NodeExecutionContext) => Promise<NodeHandlerResult>;
