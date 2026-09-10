import { describe, expect, it } from "vitest";
import { delayNodeHandler } from "./delay.node.js";

describe("delayNodeHandler", () => {
  it("returns the configured delay in its output", async () => {
    const result = await delayNodeHandler({
      db: {} as any,
      config: {} as any,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: false,
      node: { id: "n1", type: "delay", config: { seconds: 30 } },
      priorOutputs: {},
    });
    expect(result.output.delayedSeconds).toBe(30);
  });
});
