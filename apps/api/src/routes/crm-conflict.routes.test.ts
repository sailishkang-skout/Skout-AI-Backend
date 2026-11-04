import Fastify from "fastify";
import { HttpError } from "@skout/auth";
import { describe, expect, it, vi } from "vitest";
import { crmConflictRoutes } from "./crm-conflict.routes.js";
import * as conflictService from "../services/crm-conflict.service.js";

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
  await app.register(crmConflictRoutes);
  return app;
}

describe("CRM Conflict Routes", () => {
  describe("GET /crm/conflicts", () => {
    it("returns 503 if db unavailable", async () => {
      const app = await createTestApp(null);
      const res = await app.inject({
        method: "GET",
        url: "/crm/conflicts",
      });

      expect(res.statusCode).toBe(503);
    });

    it("lists conflicts with pagination and filters", async () => {
      const mockList = vi.spyOn(conflictService, "listCrmConflicts").mockResolvedValueOnce([
        {
          id: "conf-1",
          workspaceId: "ws-test-123",
          connectionId: "conn-1",
          entityType: "contact",
          entityId: "cont-1",
          externalId: "ext-1",
          fieldName: "email",
          skoutValue: "skout@test.com",
          externalValue: "ext@test.com",
          status: "pending",
          policy: "manual_review",
        } as any,
      ]);

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "GET",
        url: "/crm/conflicts?status=pending&entityType=contact&limit=10&offset=0",
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe("conf-1");
      expect(json.limit).toBe(10);
      expect(json.offset).toBe(0);

      expect(mockList).toHaveBeenCalledWith(
        expect.anything(),
        "ws-test-123",
        expect.objectContaining({
          status: "pending",
          entityType: "contact",
          limit: 10,
          offset: 0,
        })
      );
    });
  });

  describe("POST /crm/conflicts/:id/resolve", () => {
    it("returns 400 for invalid choice", async () => {
      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "POST",
        url: "/crm/conflicts/conf-1/resolve",
        payload: {
          choice: "invalid_choice",
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("choice must be 'skout', 'external', or 'custom'");
    });

    it("returns 404 when conflict is not found", async () => {
      vi.spyOn(conflictService, "resolveCrmConflict").mockRejectedValueOnce(
        new HttpError("Conflict conf-999 not found", 404)
      );

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "POST",
        url: "/crm/conflicts/conf-999/resolve",
        payload: {
          choice: "skout",
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain("not found");
    });

    it("resolves conflict successfully", async () => {
      const mockResolve = vi.spyOn(conflictService, "resolveCrmConflict").mockResolvedValueOnce({
        id: "conf-1",
        status: "resolved_external",
        resolvedValue: "ext@test.com",
        resolvedAt: new Date().toISOString(),
      });

      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "POST",
        url: "/crm/conflicts/conf-1/resolve",
        payload: {
          choice: "external",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(res.json().data.status).toBe("resolved_external");
      expect(mockResolve).toHaveBeenCalledWith(
        expect.anything(),
        "ws-test-123",
        "conf-1",
        expect.objectContaining({
          choice: "external",
          resolvedBy: "user-test-456",
        })
      );
    });
  });

  it("refuses a member without workspace:manage (403)", async () => {
    permissions.list = ["crm:manage"];
    try {
      const app = await createTestApp({} as any);
      const res = await app.inject({ method: "GET", url: "/crm/conflicts" });
      expect(res.statusCode).toBe(403);
    } finally {
      permissions.list = ["workspace:manage"];
    }
  });
});
