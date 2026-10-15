import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectSchemaDrift,
  getCrmConnectorHealth,
  listCrmOutboundWrites,
  replayCrmOutboundWrite,
} from "./crm-observability.service.js";
import * as hubspotClient from "./hubspot.client.js";
import * as mappingService from "./crm-mapping.service.js";
import * as notifService from "./notifications.service.js";
import * as routingService from "./cops-notification-routing.js";

describe("CRM Observability Service", () => {
  const workspaceId = "ws-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getCrmConnectorHealth", () => {
    it("returns disconnected when connection row does not exist", async () => {
      const dbMock: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      };

      const health = await getCrmConnectorHealth(dbMock, workspaceId, "hubspot");
      expect(health.connected).toBe(false);
      expect(health.authStatus).toBe("disconnected");
      expect(health.backlog).toBe(0);
      expect(health.failedRecords).toBe(0);
    });

    it("detects needs_reauth and aggregates backlog/failed counts", async () => {
      vi.spyOn(hubspotClient, "getHubSpotRateLimitState").mockReturnValue({
        isRateLimited: true,
        lastRateLimitedAt: "2026-10-15T12:00:00.000Z",
        limitedUntil: "2026-10-15T12:05:00.000Z",
        retryAfterMs: 300000,
      });

      let callIdx = 0;
      const dbMock: any = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              callIdx++;
              if (callIdx === 1) {
                // Connection
                return {
                  limit: vi.fn().mockResolvedValue([
                    {
                      id: "conn-1",
                      status: "needs_reauth",
                      tokenExpiresAt: null,
                      settings: {},
                    },
                  ]),
                };
              }
              if (callIdx === 2) {
                // Checkpoints
                return Promise.resolve([
                  {
                    entityType: "contact",
                    lastRunStatus: "succeeded",
                    lastRunCompletedAt: new Date("2026-10-15T10:00:00Z"),
                    lastError: null,
                    cursor: new Date("2026-10-15T10:00:00Z"),
                  },
                ]);
              }
              if (callIdx === 3) {
                // Backlog
                return Promise.resolve([{ count: 5 }]);
              }
              if (callIdx === 4) {
                // Failed records (DLQ)
                return Promise.resolve([{ count: 2 }]);
              }
              if (callIdx === 5) {
                // Pending conflicts
                return Promise.resolve([{ count: 1 }]);
              }
              return Promise.resolve([]);
            }),
          }),
        })),
      };

      const health = await getCrmConnectorHealth(dbMock, workspaceId, "hubspot");
      expect(health.connected).toBe(true);
      expect(health.authStatus).toBe("needs_reauth");
      expect(health.backlog).toBe(5);
      expect(health.failedRecords).toBe(2);
      expect(health.pendingConflicts).toBe(1);
      expect(health.lastSyncAt).toBe("2026-10-15T10:00:00.000Z");
      expect(health.rateLimitState?.isRateLimited).toBe(true);
    });

    it("marks authStatus as expired when token expiration is in past", async () => {
      let callIdx = 0;
      const dbMock: any = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              callIdx++;
              if (callIdx === 1) {
                return {
                  limit: vi.fn().mockResolvedValue([
                    {
                      id: "conn-1",
                      status: "connected",
                      tokenExpiresAt: new Date(Date.now() - 60000), // 1 min ago
                      settings: {},
                    },
                  ]),
                };
              }
              return Promise.resolve([]);
            }),
          }),
        })),
      };

      const health = await getCrmConnectorHealth(dbMock, workspaceId, "hubspot");
      expect(health.authStatus).toBe("expired");
    });
  });

  describe("replayCrmOutboundWrite", () => {
    it("throws when write does not exist", async () => {
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
        replayCrmOutboundWrite(dbMock, workspaceId, "nonexistent-id")
      ).rejects.toThrow("not found");
    });

    it("throws when write is not in failed status", async () => {
      const dbMock: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "write-1",
                  status: "pending",
                },
              ]),
            }),
          }),
        }),
      };

      await expect(
        replayCrmOutboundWrite(dbMock, workspaceId, "write-1")
      ).rejects.toThrow("Only failed writes can be replayed");
    });

    it("resets failed write to pending and records audit log", async () => {
      let updatedData: any;
      let insertedAudit: any;

      const dbMock: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "write-1",
                  workspaceId,
                  entityType: "contact",
                  entityId: "11111111-1111-1111-1111-111111111111",
                  status: "failed",
                  attemptCount: 3,
                  lastError: "HubSpot API error 500",
                },
              ]),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation((val) => {
            updatedData = val;
            return {
              where: vi.fn().mockResolvedValue([]),
            };
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((val) => {
            insertedAudit = val;
            return Promise.resolve();
          }),
        }),
      };

      const res = await replayCrmOutboundWrite(dbMock, workspaceId, "write-1", "user-123");
      expect(res.ok).toBe(true);
      expect(res.status).toBe("pending");

      expect(updatedData.status).toBe("pending");
      expect(updatedData.attemptCount).toBe(0);
      expect(updatedData.lastError).toBeNull();

      expect(insertedAudit.action).toBe("crm_outbound_write.replayed");
      expect(insertedAudit.actorId).toBe("user-123");
      expect(insertedAudit.actorType).toBe("user");
    });
  });

  describe("detectSchemaDrift", () => {
    it("reports no drift when all mapped fields are present in provider schema", async () => {
      vi.spyOn(mappingService, "getResolvedCrmMapping").mockResolvedValue({
        version: 1,
        entityType: "contact",
        fields: [
          { internalField: "email", externalField: "email", direction: "bi-directional" },
          { internalField: "firstName", externalField: "firstname", direction: "bi-directional" },
        ],
      } as any);

      const dbMock: any = {};
      const configMock: any = {};

      const result = await detectSchemaDrift(
        dbMock,
        configMock,
        workspaceId,
        "hubspot",
        "contact",
        ["email", "firstname", "lastname", "phone"]
      );

      expect(result.driftDetected).toBe(false);
      expect(result.missingFields).toHaveLength(0);
    });

    it("detects drift and creates in-app notifications when mapped fields are missing", async () => {
      vi.spyOn(mappingService, "getResolvedCrmMapping").mockResolvedValue({
        version: 1,
        entityType: "deal",
        fields: [
          { internalField: "name", externalField: "dealname", direction: "bi-directional" },
          { internalField: "amount", externalField: "amount", direction: "bi-directional" },
          { internalField: "customCode", externalField: "custom_code", direction: "bi-directional" },
        ],
      } as any);

      const notifSpy = vi.spyOn(notifService, "createNotification").mockResolvedValue({} as any);
      vi.spyOn(routingService, "getCopsNotificationRecipients").mockResolvedValue(["admin-1"]);

      const dbMock: any = {};
      const configMock: any = {};

      const result = await detectSchemaDrift(
        dbMock,
        configMock,
        workspaceId,
        "hubspot",
        "deal",
        ["dealname", "amount"] // missing "custom_code"
      );

      expect(result.driftDetected).toBe(true);
      expect(result.missingFields).toEqual(["custom_code"]);
      expect(notifSpy).toHaveBeenCalled();
    });
  });
});
