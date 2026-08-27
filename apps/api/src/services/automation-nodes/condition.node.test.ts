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

  it("matches a numeric prior-output field against the config panel's string value", async () => {
    // The Value field in node-config-panel.tsx is a plain text input, so `value` here is always
    // a string — e.g. comparing action_http's real (non-simulation) numeric status code.
    const result = await conditionNodeHandler(
      ctx({ sourceNodeId: "n0", field: "status", op: "equals", value: "200" }, { n0: { status: 200 } })
    );
    expect(result.branch).toBe("true");
    expect(result.output).toEqual({ actual: 200, matches: true });
  });

  it("not_equals branches true when a numeric field differs from the string value", async () => {
    const result = await conditionNodeHandler(
      ctx({ sourceNodeId: "n0", field: "status", op: "not_equals", value: "200" }, { n0: { status: 500 } })
    );
    expect(result.branch).toBe("true");
  });

  it("treats a missing prior-output field as never matching a real value", async () => {
    const result = await conditionNodeHandler(
      ctx({ sourceNodeId: "n0", field: "missing", op: "equals", value: "200" }, { n0: { status: 200 } })
    );
    expect(result.branch).toBe("false");
  });
});
