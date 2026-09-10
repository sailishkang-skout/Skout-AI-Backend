import { describe, expect, it } from "vitest";
import { triggerNodeHandler } from "./trigger.node.js";

describe("triggerNodeHandler", () => {
  it("is a no-op that just marks the start of the graph", async () => {
    const result = await triggerNodeHandler({
      db: {} as any,
      config: {} as any,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: false,
      node: { id: "n1", type: "trigger", config: { triggerType: "manual" } },
      priorOutputs: {},
    });
    expect(result.output).toEqual({});
  });
});
