import Fastify from "fastify";
import { HttpError } from "@skout/auth";
import { describe, expect, it, vi } from "vitest";
import { crmImportRoutes } from "./crm-import.routes.js";
import * as optInService from "../services/crm-opt-in.service.js";
import * as importService from "../services/crm-initial-import.service.js";
import * as nativeSync from "../services/crm-hubspot-native-sync.service.js";

// The routes are gated on workspace:manage (Owner, Admin); tests run as an admin unless they say otherwise.
const permissions = vi.hoisted(() => ({ list: ["workspace:manage"] as string[] }));
vi.mock("@skout/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@skout/auth")>()),
  getMemberPermissions: vi.fn(async () => permissions.list),
}));


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
        accountScope: ["8f6b7a52-3c1d-4f7e-9a2b-1c2d3e4f5a6b"],
        objectScope: { contacts: true, deals: false },
        pollIntervalMinutes: 15,
      });

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "PUT",
        url: "/crm/hubspot/opt-in",
        payload: {
          syncEnabled: true,
          accountScope: ["8f6b7a52-3c1d-4f7e-9a2b-1c2d3e4f5a6b"],
          objectScope: { contacts: true, deals: false },
          pollIntervalMinutes: 15,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(res.json().data.syncEnabled).toBe(true);
      expect(res.json().data.accountScope).toEqual(["8f6b7a52-3c1d-4f7e-9a2b-1c2d3e4f5a6b"]);
    });
  });

  describe("POST /crm/:provider/import", () => {
    it("returns 409 when workspace has not opted into sync", async () => {
      vi.spyOn(importService, "runInitialCrmImport").mockRejectedValueOnce(
        new HttpError("crm_sync_not_enabled", 409)
      );

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "POST",
        url: "/crm/hubspot/import",
        payload: {},
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe("crm_sync_not_enabled");
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

  it("refuses a member without workspace:manage (403)", async () => {
    permissions.list = ["crm:manage"];
    try {
      const app = await createTestApp({} as any);
      const res = await app.inject({ method: "GET", url: "/crm/hubspot/opt-in" });
      expect(res.statusCode).toBe(403);
    } finally {
      permissions.list = ["workspace:manage"];
    }
  });
});
