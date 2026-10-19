import { describe, expect, it } from "vitest";
import { validateAutomationGraph } from "./automation-graph-validate.js";
import type { AutomationGraph } from "./automation-graph.js";

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, config }) as AutomationGraph["nodes"][number];

describe("validateAutomationGraph", () => {
  it("refuses a node type outside the allowlist, even in a draft", () => {
    const issues = validateAutomationGraph({ nodes: [node("a", "run_code")], edges: [] }, { strict: false });
    expect(issues).toEqual([{ path: "nodes[0].type", message: "Node type run_code is not allowed" }]);
  });

  it("lets a draft be incomplete but not a published version", () => {
    const graph: AutomationGraph = { nodes: [node("t", "trigger"), node("n", "action_notification")], edges: [{ id: "e", source: "t", target: "n" }] };
    expect(validateAutomationGraph(graph, { strict: false })).toEqual([]);
    expect(validateAutomationGraph(graph, { strict: true })).toEqual([{ path: "nodes[1].config.title", message: "action_notification needs title" }]);
  });

  it("accepts templated values", () => {
    const graph: AutomationGraph = { nodes: [node("t", "trigger"), node("n", "action_notification", { title: "{{t.name}}" })], edges: [{ id: "e", source: "t", target: "n" }] };
    expect(validateAutomationGraph(graph, { strict: true })).toEqual([]);
  });

  it("flags duplicate ids, dangling edges, unbranched condition edges, loops and bad delays", () => {
    const graph: AutomationGraph = {
      nodes: [
        node("c", "condition", { sourceNodeId: "c", field: "x", op: "equals" }),
        node("d", "delay", { seconds: -5 }),
        node("d", "trigger"),
      ],
      edges: [
        { id: "e1", source: "c", target: "d" },
        { id: "e2", source: "d", target: "c", branch: "true" },
        { id: "e3", source: "d", target: "missing" },
      ],
    };
    const paths = validateAutomationGraph(graph, { strict: true }).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["nodes[1].config.seconds", "nodes[2].id", "edges[0].branch", "edges[2].target", "edges"]));
  });
});
