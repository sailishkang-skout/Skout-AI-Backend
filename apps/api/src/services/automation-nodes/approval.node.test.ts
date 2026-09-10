import { describe, expect, it, vi } from "vitest";
import { approvalNodeHandler } from "./approval.node.js";
import * as policyGateway from "../policy-gateway.service.js";
import { HttpError } from "../../utils/http.js";

describe("approvalNodeHandler", () => {
  it("returns allowed output when the Policy Gateway allows the action", async () => {
    vi.spyOn(policyGateway, "assertAllowed").mockResolvedValue({
      actionKey: "workflow.step_approval",
      mode: "auto",
      outcome: "allowed",
      decisionId: "dec-1",
    });
    const result = await approvalNodeHandler({
      db: {} as any,
      config: {} as any,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: false,
      node: { id: "n1", type: "approval", config: { entityType: "workflow_run", entityId: "run-1" } },
      priorOutputs: {},
    });
    expect(result.output.decisionId).toBe("dec-1");
  });

  it("propagates the HttpError when the Policy Gateway denies the action", async () => {
    vi.spyOn(policyGateway, "assertAllowed").mockRejectedValue(new HttpError("Policy Gateway denied", 403));
    await expect(
      approvalNodeHandler({
        db: {} as any,
        config: {} as any,
        workspaceId: "ws-1",
        runId: "run-1",
        isSimulation: false,
        node: { id: "n1", type: "approval", config: { entityType: "workflow_run", entityId: "run-1" } },
        priorOutputs: {},
      })
    ).rejects.toThrow(HttpError);
  });
});
