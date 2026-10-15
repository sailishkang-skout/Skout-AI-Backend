import { describe, expect, it, vi } from "vitest";
import { runInitialCrmImport, runScheduledCrmPoll } from "./crm-initial-import.service.js";
import * as nativeSync from "./crm-hubspot-native-sync.service.js";

describe("CRM Initial Import and Scheduled Poll", () => {
  const workspaceId = "ws-test-123";
  const configMock: any = {
    HUBSPOT_CLIENT_ID: "client-id",
    HUBSPOT_CLIENT_SECRET: "client-secret",
  };

  describe("runInitialCrmImport", () => {
    it("throws if connection does not exist", async () => {
      const dbMock: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      };

      await expect(
        runInitialCrmImport(dbMock, configMock, workspaceId, "hubspot")
      ).rejects.toThrow("No CRM connection found");
    });

    it("throws if workspace has not opted in under ADR 0014", async () => {
      const dbMock: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "conn-1",
                  status: "connected",
                  settings: { syncEnabled: false },
                },
              ]),
            }),
          }),
        }),
      };

      await expect(
        runInitialCrmImport(dbMock, configMock, workspaceId, "hubspot")
      ).rejects.toThrow("CRM sync is not enabled for this workspace");
    });

    it("runs paged import and terminates when all records are imported", async () => {
      let callCount = 0;
      vi.spyOn(nativeSync, "syncHubSpotNativeOrThrow").mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            contacts: { pulled: 100, created: 80, updated: 20, skipped: 0 },
            deals: { pulled: 50, created: 50, updated: 0, skipped: 0 },
          };
        }
        return {
          contacts: { pulled: 25, created: 10, updated: 15, skipped: 0 },
          deals: { pulled: 10, created: 5, updated: 5, skipped: 0 },
        };
      });

      const dbMock: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "conn-1",
                  status: "connected",
                  settings: { syncEnabled: true },
                },
              ]),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue(Promise.resolve()),
        }),
      };

      const result = await runInitialCrmImport(dbMock, configMock, workspaceId, "hubspot", {
        batchSize: 100,
        maxBatches: 5,
      });

      expect(result.completed).toBe(true);
      expect(result.batchesRun).toBe(2);
      expect(result.contacts.pulled).toBe(125);
      expect(result.contacts.created).toBe(90);
      expect(result.deals.pulled).toBe(60);
    });
  });

  describe("runScheduledCrmPoll", () => {
    it("polls only opted-in connections and handles individual failures", async () => {
      const syncSpy = vi
        .spyOn(nativeSync, "syncHubSpotNativeOrThrow")
        .mockResolvedValueOnce({
          contacts: { pulled: 5, created: 5, updated: 0, skipped: 0 },
          deals: { pulled: 2, created: 2, updated: 0, skipped: 0 },
        })
        .mockRejectedValueOnce(new Error("Network timeout"));

      const dbMock: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                id: "conn-1",
                workspaceId: "ws-1",
                provider: "hubspot",
                settings: { syncEnabled: true },
              },
              {
                id: "conn-2",
                workspaceId: "ws-2",
                provider: "hubspot",
                settings: { syncEnabled: false }, // Not opted in
              },
              {
                id: "conn-3",
                workspaceId: "ws-3",
                provider: "hubspot",
                settings: { syncEnabled: true },
              },
            ]),
          }),
        }),
      };

      const pollResult = await runScheduledCrmPoll(dbMock, configMock);
      expect(pollResult.totalEligible).toBe(2);
      expect(pollResult.synced).toBe(1);
      expect(pollResult.failed).toBe(1);
      expect(syncSpy).toHaveBeenCalledTimes(2);
    });
  });
});
