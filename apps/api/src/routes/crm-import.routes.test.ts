import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { crmImportRoutes } from "./crm-import.routes.js";
import * as optInService from "../services/crm-opt-in.service.js";
import * as importService from "../services/crm-initial-import.service.js";
import * as nativeSync from "../services/crm-hubspot-native-sync.service.js";

async function createTestApp(dbMock?: any) {
  const app = Fastify();
  app.decorate("db", dbMock ?? null);
  app.decorate("config", {
    HUBSPOT_CLIENT_ID: "client-id",
    HUBSPOT_CLIENT_SECRET: "client-secret",
  } as any);
  app.addHook("onRequest", async (req: any) => {
    req.workspaceId = "ws-test-123";
    req.userId = "user-test-456";
  });
  await app.register(crmImportRoutes);
  return app;
}

describe("CRM Import and Opt-In Routes", () => {
  describe("GET /crm/:provider/opt-in", () => {
    it("returns 404 for unsupported provider", async () => {
      const app = await createTestApp();
      const res = await app.inject({
        method: "GET",
        url: "/crm/unknown_provider/opt-in",
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain("Unsupported CRM provider");
    });

    it("returns opt-in settings", async () => {
      vi.spyOn(optInService, "getCrmSyncOptIn").mockResolvedValueOnce({
        syncEnabled: true,
        accountScope: ["*"],
        objectScope: { contacts: true, deals: true },
        pollIntervalMinutes: 30,
      });

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "GET",
        url: "/crm/hubspot/opt-in",
      });

      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.syncEnabled).toBe(true);
      expect(data.accountScope).toEqual(["*"]);
    });
  });

  describe("PUT /crm/:provider/opt-in", () => {
    it("updates opt-in settings", async () => {
      vi.spyOn(optInService, "updateCrmSyncOptIn").mockResolvedValueOnce({
        syncEnabled: true,
        accountScope: ["acc-123"],
        objectScope: { contacts: true, deals: false },
        pollIntervalMinutes: 15,
      });

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "PUT",
        url: "/crm/hubspot/opt-in",
        payload: {
          syncEnabled: true,
          accountScope: ["acc-123"],
          objectScope: { contacts: true, deals: false },
          pollIntervalMinutes: 15,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(res.json().data.syncEnabled).toBe(true);
      expect(res.json().data.accountScope).toEqual(["acc-123"]);
    });
  });

  describe("POST /crm/:provider/import", () => {
    it("returns 403 when workspace has not opted into sync", async () => {
      vi.spyOn(importService, "runInitialCrmImport").mockRejectedValueOnce(
        new Error("CRM sync is not enabled for this workspace. Opt-in is required under ADR 0014.")
      );

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "POST",
        url: "/crm/hubspot/import",
        payload: {},
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain("not enabled");
    });

    it("runs initial import successfully", async () => {
      vi.spyOn(importService, "runInitialCrmImport").mockResolvedValueOnce({
        completed: true,
        batchesRun: 2,
        contacts: { pulled: 50, created: 40, updated: 10, skipped: 0 },
        deals: { pulled: 20, created: 20, updated: 0, skipped: 0 },
      });

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "POST",
        url: "/crm/hubspot/import",
        payload: {
          maxBatches: 5,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(res.json().data.completed).toBe(true);
      expect(res.json().data.contacts.pulled).toBe(50);
    });
  });

  describe("POST /crm/:provider/poll", () => {
    it("triggers on-demand sync", async () => {
      vi.spyOn(nativeSync, "syncHubSpotNativeOrThrow").mockResolvedValueOnce({
        contacts: { pulled: 5, created: 5, updated: 0, skipped: 0 },
        deals: { pulled: 2, created: 2, updated: 0, skipped: 0 },
      });

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "POST",
        url: "/crm/hubspot/poll",
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(res.json().data.contacts.pulled).toBe(5);
    });
  });
});
