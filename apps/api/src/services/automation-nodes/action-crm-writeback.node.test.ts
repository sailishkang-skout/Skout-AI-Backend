import { describe, expect, it, vi } from "vitest";
import { crmWritebackActionNodeHandler } from "./action-crm-writeback.node.js";

function makeDb() {
  const returning = vi.fn().mockResolvedValue([{ id: "activity-1" }]);
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  return { insert } as any;
}

describe("crmWritebackActionNodeHandler", () => {
  it("inserts an activity row and returns its id", async () => {
    const db = makeDb();
    const result = await crmWritebackActionNodeHandler({
      db,
      config: {} as any,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: false,
      node: {
        id: "n1",
        type: "action_crm_writeback",
        config: { entityType: "contact", entityId: "contact-1", activityType: "workflow_action", subject: "Automated note" },
      },
      priorOutputs: {},
    });
    expect(db.insert).toHaveBeenCalled();
    expect(result.output.activityId).toBe("activity-1");
  });

  it("defaults entityType/activityType when the config panel's fields were never touched", async () => {
    const db = makeDb();
    await crmWritebackActionNodeHandler({
      db,
      config: {} as any,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: false,
      node: { id: "n1", type: "action_crm_writeback", config: { entityId: "contact-1" } },
      priorOutputs: {},
    });
    const inserted = db.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(inserted.entityType).toBe("contact");
    expect(inserted.activityType).toBe("workflow_action");
  });

  it("throws a clear error instead of a raw NOT NULL violation when entityId is missing", async () => {
    const db = makeDb();
    await expect(
      crmWritebackActionNodeHandler({
        db,
        config: {} as any,
        workspaceId: "ws-1",
        runId: "run-1",
        isSimulation: false,
        node: { id: "n1", type: "action_crm_writeback", config: { entityType: "contact", activityType: "workflow_action" } },
        priorOutputs: {},
      })
    ).rejects.toThrow(/entityId/);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("skips the write in simulation mode", async () => {
    const db = makeDb();
    const result = await crmWritebackActionNodeHandler({
      db,
      config: {} as any,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: true,
      node: { id: "n1", type: "action_crm_writeback", config: { entityType: "contact", entityId: "contact-1", activityType: "workflow_action" } },
      priorOutputs: {},
    });
    expect(db.insert).not.toHaveBeenCalled();
    expect(result.output.simulated).toBe(true);
  });
});
