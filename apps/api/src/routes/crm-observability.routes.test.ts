import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { crmObservabilityRoutes } from "./crm-observability.routes.js";
import * as obsService from "../services/crm-observability.service.js";

async function createTestApp(dbMock?: any) {
  const app = Fastify();
  app.decorate("db", dbMock ?? null);
  app.decorate("config", {} as any);
  app.addHook("onRequest", async (req: any) => {
    req.workspaceId = "ws-test-123";
    req.userId = "user-test-456";
  });
  await app.register(crmObservabilityRoutes);
  return app;
}

describe("CRM Observability Routes", () => {
  describe("GET /crm/:provider/health", () => {
    it("returns 404 for unsupported provider", async () => {
      const app = await createTestApp();
      const res = await app.inject({
        method: "GET",
        url: "/crm/unknown_crm/health",
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain("Unsupported CRM provider");
    });

    it("returns 503 if db is unavailable", async () => {
      const app = await createTestApp(null);
      const res = await app.inject({
        method: "GET",
        url: "/crm/hubspot/health",
      });

      expect(res.statusCode).toBe(503);
    });

    it("returns connector health data", async () => {
      vi.spyOn(obsService, "getCrmConnectorHealth").mockResolvedValueOnce({
        connected: true,
        provider: "hubspot",
        authStatus: "connected",
        lastSyncAt: "2026-10-15T12:00:00.000Z",
        backlog: 3,
        failedRecords: 1,
        pendingConflicts: 0,
        rateLimitState: null,
        checkpoints: [],
      });

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "GET",
        url: "/crm/hubspot/health",
      });

      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.provider).toBe("hubspot");
      expect(data.authStatus).toBe("connected");
      expect(data.backlog).toBe(3);
      expect(data.failedRecords).toBe(1);
    });
  });

  describe("GET /crm/outbound-writes", () => {
    it("lists outbound writes with pagination", async () => {
      vi.spyOn(obsService, "listCrmOutboundWrites").mockResolvedValueOnce([
        {
          id: "write-1",
          workspaceId: "ws-test-123",
          status: "failed",
          entityType: "contact",
        } as any,
      ]);

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "GET",
        url: "/crm/outbound-writes?status=failed&limit=25&offset=0",
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data).toHaveLength(1);
      expect(json.limit).toBe(25);
    });
  });

  describe("POST /crm/outbound-writes/:id/replay", () => {
    it("returns 404 when write not found", async () => {
      vi.spyOn(obsService, "replayCrmOutboundWrite").mockRejectedValueOnce(
        new Error("Outbound write write-999 not found")
      );

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "POST",
        url: "/crm/outbound-writes/write-999/replay",
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain("not found");
    });

    it("returns 400 when write is not failed", async () => {
      vi.spyOn(obsService, "replayCrmOutboundWrite").mockRejectedValueOnce(
        new Error("Only failed writes can be replayed")
      );

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "POST",
        url: "/crm/outbound-writes/write-1/replay",
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("Only failed writes");
    });

    it("replays write successfully", async () => {
      vi.spyOn(obsService, "replayCrmOutboundWrite").mockResolvedValueOnce({
        ok: true,
        id: "write-1",
        status: "pending",
        replayedAt: new Date().toISOString(),
      });

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "POST",
        url: "/crm/outbound-writes/write-1/replay",
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(res.json().data.status).toBe("pending");
    });
  });

  describe("POST /crm/:provider/schema-drift", () => {
    it("validates entityType", async () => {
      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "POST",
        url: "/crm/hubspot/schema-drift",
        payload: {
          entityType: "invalid_type",
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("entityType must be 'contact' or 'deal'");
    });

    it("checks schema drift successfully", async () => {
      vi.spyOn(obsService, "detectSchemaDrift").mockResolvedValueOnce({
        driftDetected: true,
        missingFields: ["custom_field"],
      });

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "POST",
        url: "/crm/hubspot/schema-drift",
        payload: {
          entityType: "contact",
          providerProperties: ["email", "firstname"],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(res.json().data.driftDetected).toBe(true);
      expect(res.json().data.missingFields).toEqual(["custom_field"]);
    });
  });
});
