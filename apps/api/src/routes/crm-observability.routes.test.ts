import Fastify from "fastify";
import { HttpError } from "@skout/auth";
import { describe, expect, it, vi } from "vitest";
import { crmObservabilityRoutes } from "./crm-observability.routes.js";
import * as exportRunner from "../services/crm-export.runner.js";
import * as obsService from "../services/crm-observability.service.js";

// The routes are gated on workspace:manage (Owner, Admin); tests run as an admin unless they say otherwise.
const permissions = vi.hoisted(() => ({ list: ["workspace:manage"] as string[] }));
vi.mock("@skout/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@skout/auth")>()),
  getMemberPermissions: vi.fn(async () => permissions.list),
}));


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
        new HttpError("Outbound write write-999 not found", 404)
      );

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "POST",
        url: "/crm/outbound-writes/write-999/replay",
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain("not found");
    });

    it("returns 409 when write is not failed", async () => {
      vi.spyOn(obsService, "replayCrmOutboundWrite").mockRejectedValueOnce(
        new HttpError("Only failed writes can be replayed", 409)
      );

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "POST",
        url: "/crm/outbound-writes/write-1/replay",
      });

      expect(res.statusCode).toBe(409);
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
    it("is only implemented for HubSpot", async () => {
      const app = await createTestApp({} as any);
      const res = await app.inject({ method: "POST", url: "/crm/salesforce/schema-drift" });
      expect([400, 404]).toContain(res.statusCode);
    });

    it("checks the mappings against HubSpot's live properties", async () => {
      vi.spyOn(exportRunner, "ensureFreshTokens").mockResolvedValueOnce({ accessToken: "tok", refreshToken: "r", expiresAt: "" } as any);
      const check = vi.spyOn(obsService, "checkHubSpotSchemaDrift").mockResolvedValueOnce({
        contact: { driftDetected: true, missingFields: ["custom_field"] },
        deal: { driftDetected: false, missingFields: [] },
      });

      const app = await createTestApp({} as any);
      const res = await app.inject({ method: "POST", url: "/crm/hubspot/schema-drift" });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.contact.missingFields).toEqual(["custom_field"]);
      expect(check).toHaveBeenCalledWith(expect.anything(), expect.anything(), "ws-test-123", "tok");
    });
  });

  it("refuses a member without workspace:manage (403)", async () => {
    permissions.list = ["crm:manage"];
    try {
      const app = await createTestApp({} as any);
      const res = await app.inject({ method: "GET", url: "/crm/hubspot/health" });
      expect(res.statusCode).toBe(403);
    } finally {
      permissions.list = ["workspace:manage"];
    }
  });
});
