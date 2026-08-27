import { describe, expect, it } from "vitest";
import { conditionNodeHandler } from "./condition.node.js";
import type { NodeExecutionContext } from "./types.js";

function ctx(config: Record<string, unknown>, priorOutputs: Record<string, unknown> = {}): NodeExecutionContext {
  return {
    db: {} as any,
    config: {} as any,
    workspaceId: "ws-1",
    runId: "run-1",
    isSimulation: false,
    node: { id: "n1", type: "condition", config },
    priorOutputs,
  };
}

describe("conditionNodeHandler", () => {
  it("branches true when the field equals the expected value", async () => {
    const result = await conditionNodeHandler(
      ctx({ sourceNodeId: "n0", field: "status", op: "equals", value: "active" }, { n0: { status: "active" } })
    );
    expect(result.branch).toBe("true");
  });

  it("branches false when the field does not match", async () => {
    const result = await conditionNodeHandler(
      ctx({ sourceNodeId: "n0", field: "status", op: "equals", value: "active" }, { n0: { status: "paused" } })
    );
    expect(result.branch).toBe("false");
  });
});
