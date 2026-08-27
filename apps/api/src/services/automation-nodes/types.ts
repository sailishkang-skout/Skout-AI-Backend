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
}

export type NodeHandler = (ctx: NodeExecutionContext) => Promise<NodeHandlerResult>;
