import { describe, expect, it, vi } from "vitest";
import { notificationActionNodeHandler } from "./action-notification.node.js";
import * as notificationsService from "../notifications.service.js";

describe("notificationActionNodeHandler", () => {
  it("calls createNotification with the configured title/body and returns the notification id", async () => {
    vi.spyOn(notificationsService, "createNotification").mockResolvedValue({ id: "notif-1" } as any);
    const result = await notificationActionNodeHandler({
      db: {} as any,
      config: {} as any,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: false,
      node: { id: "n1", type: "action_notification", config: { title: "Hi", body: "Workflow fired", type: "workflow" } },
      priorOutputs: {},
    });
    expect(notificationsService.createNotification).toHaveBeenCalledWith(
      {},
      {},
      expect.objectContaining({ workspaceId: "ws-1", title: "Hi", body: "Workflow fired", type: "workflow" })
    );
    expect(result.output.notificationId).toBe("notif-1");
  });

  it("defaults type to 'workflow' when the config panel's field was never touched", async () => {
    vi.spyOn(notificationsService, "createNotification").mockResolvedValue({ id: "notif-2" } as any);
    // `type` is genuinely absent here — a node the user added but never opened the Type field
    // for, matching what the frontend actually persists. `type` is a NOT NULL DB column with
    // no default, so this crashed the insert before the handler applied its own fallback.
    await notificationActionNodeHandler({
      db: {} as any,
      config: {} as any,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: false,
      node: { id: "n1", type: "action_notification", config: { title: "Hi" } },
      priorOutputs: {},
    });
    expect(notificationsService.createNotification).toHaveBeenCalledWith(
      {},
      {},
      expect.objectContaining({ type: "workflow" })
    );
  });

  it("skips the actual send in simulation mode", async () => {
    vi.spyOn(notificationsService, "createNotification").mockClear();
    const result = await notificationActionNodeHandler({
      db: {} as any,
      config: {} as any,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: true,
      node: { id: "n1", type: "action_notification", config: { title: "Hi", type: "workflow" } },
      priorOutputs: {},
    });
    expect(notificationsService.createNotification).not.toHaveBeenCalled();
    expect(result.output.simulated).toBe(true);
  });
});
