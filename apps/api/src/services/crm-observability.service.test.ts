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

  });
});
