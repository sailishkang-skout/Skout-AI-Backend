import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../../config/env.js";

const queueCrmOutboundWriteIfOwned = vi.fn().mockResolvedValue(undefined);
vi.mock("../crm-outbound-sync.service.js", () => ({
  queueCrmOutboundWriteIfOwned: (...args: unknown[]) => queueCrmOutboundWriteIfOwned(...args),
}));

const { crmSyncActionNodeHandler } = await import("./action-crm-sync.node.js");

const config = {} as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("crmSyncActionNodeHandler", () => {
  it("queues an outbound write via Aditya's ADI-10 push-back mechanism for an owned field", async () => {
    const result = await crmSyncActionNodeHandler({
      db: {} as never,
      config,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: false,
      node: {
        id: "n1",
        type: "action_crm_sync",
        config: { entityType: "contact", entityId: "contact-1", patch: { firstName: "Jane", notAField: "x" } },
      },
      priorOutputs: {},
    });

    expect(queueCrmOutboundWriteIfOwned).toHaveBeenCalledWith(
      {},
      "ws-1",
      "contact",
      "contact-1",
      { firstName: "Jane", notAField: "x" }
    );
    // Only the CRM-sync-owned subset is reported back, matching what actually gets queued.
    expect(result.output).toEqual({
      entityType: "contact",
      entityId: "contact-1",
      ownedPatch: { firstName: "Jane" },
      queued: true,
    });
  });

  it("reports queued: false when the patch has no CRM-sync-owned fields, without erroring", async () => {
    const result = await crmSyncActionNodeHandler({
      db: {} as never,
      config,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: false,
      node: { id: "n1", type: "action_crm_sync", config: { entityType: "contact", entityId: "contact-1", patch: { notAField: "x" } } },
      priorOutputs: {},
    });
    expect(result.output.queued).toBe(false);
  });

  it("throws a clear error for an invalid entityType", async () => {
    await expect(
      crmSyncActionNodeHandler({
        db: {} as never,
        config,
        workspaceId: "ws-1",
        runId: "run-1",
        isSimulation: false,
        node: { id: "n1", type: "action_crm_sync", config: { entityType: "company", entityId: "c-1", patch: {} } },
        priorOutputs: {},
      })
    ).rejects.toThrow(/entityType/);
    expect(queueCrmOutboundWriteIfOwned).not.toHaveBeenCalled();
  });

  it("throws a clear error when entityId is missing", async () => {
    await expect(
      crmSyncActionNodeHandler({
        db: {} as never,
        config,
        workspaceId: "ws-1",
        runId: "run-1",
        isSimulation: false,
        node: { id: "n1", type: "action_crm_sync", config: { entityType: "deal", patch: {} } },
        priorOutputs: {},
      })
    ).rejects.toThrow(/entityId/);
  });

  it("does not queue anything in simulation mode", async () => {
    const result = await crmSyncActionNodeHandler({
      db: {} as never,
      config,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: true,
      node: { id: "n1", type: "action_crm_sync", config: { entityType: "deal", entityId: "deal-1", patch: { amount: 500 } } },
      priorOutputs: {},
    });
    expect(queueCrmOutboundWriteIfOwned).not.toHaveBeenCalled();
    expect(result.output.simulated).toBe(true);
    expect(result.output.ownedPatch).toEqual({ amount: 500 });
  });
});
