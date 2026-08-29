import { describe, expect, it, vi } from "vitest";
import { sequenceEnrollActionNodeHandler } from "./action-sequence-enroll.node.js";
import { SequenceService } from "../sequence.service.js";

describe("sequenceEnrollActionNodeHandler", () => {
  it("enrolls the configured prospect into the configured sequence", async () => {
    vi.spyOn(SequenceService.prototype, "enroll").mockResolvedValue({
      enrolled: 1,
      skipped: 0,
      total: 1,
      newEnrollments: [{ enrollmentId: "enr-1", prospectId: "p-1", firstStepScheduledAt: null }],
    });

    const result = await sequenceEnrollActionNodeHandler({
      db: {} as any,
      config: {} as any,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: false,
      node: { id: "n1", type: "action_sequence_enroll", config: { sequenceId: "seq-1", prospectId: "p-1" } },
      priorOutputs: {},
    });

    expect(result.output.enrolled).toBe(1);
    expect(result.output.enrollmentId).toBe("enr-1");
  });

  it("does not call enroll in simulation mode", async () => {
    const spy = vi.spyOn(SequenceService.prototype, "enroll").mockClear();
    const result = await sequenceEnrollActionNodeHandler({
      db: {} as any,
      config: {} as any,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: true,
      node: { id: "n1", type: "action_sequence_enroll", config: { sequenceId: "seq-1", prospectId: "p-1" } },
      priorOutputs: {},
    });
    expect(spy).not.toHaveBeenCalled();
    expect(result.output.simulated).toBe(true);
  });
});
