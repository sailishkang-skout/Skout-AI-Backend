import type { NodeType } from "../automation-graph.js";
import type { NodeHandler } from "./types.js";
import { conditionNodeHandler } from "./condition.node.js";
import { delayNodeHandler } from "./delay.node.js";
import { httpActionNodeHandler } from "./action-http.node.js";
import { notificationActionNodeHandler } from "./action-notification.node.js";
import { crmWritebackActionNodeHandler } from "./action-crm-writeback.node.js";
import { sequenceEnrollActionNodeHandler } from "./action-sequence-enroll.node.js";
import { approvalNodeHandler } from "./approval.node.js";

const registry: Partial<Record<NodeType, NodeHandler>> = {
  condition: conditionNodeHandler,
  delay: delayNodeHandler,
  action_http: httpActionNodeHandler,
  action_notification: notificationActionNodeHandler,
  action_crm_writeback: crmWritebackActionNodeHandler,
  action_sequence_enroll: sequenceEnrollActionNodeHandler,
  approval: approvalNodeHandler,
};

/** Registers a handler for a node type — called by later tasks to add action/approval handlers. */
export function registerNodeHandler(type: NodeType, handler: NodeHandler): void {
  registry[type] = handler;
}

export function getNodeHandler(type: NodeType): NodeHandler {
  const handler = registry[type];
  if (!handler) throw new Error(`No handler registered for node type: ${type}`);
  return handler;
}
