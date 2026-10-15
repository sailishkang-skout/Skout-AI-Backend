import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { crmMappingRoutes } from "./crm-mapping.routes.js";
import { DEFAULT_HUBSPOT_CONTACT_MAPPING, DEFAULT_HUBSPOT_DEAL_MAPPING } from "../services/crm-mapping.service.js";

async function createTestApp(dbMock?: any) {
  const app = Fastify();
  app.decorate("db", dbMock ?? null);
  app.decorate("config", {} as any);
  app.addHook("onRequest", async (req: any) => {
    req.workspaceId = "ws-test-123";
  });
  await app.register(crmMappingRoutes);
  return app;
}

describe("CRM Mapping Routes", () => {
  describe("GET /crm/:provider/mappings", () => {
    it("returns 404 for unsupported provider", async () => {
      const app = await createTestApp();
      const res = await app.inject({
        method: "GET",
        url: "/crm/unknown_crm/mappings",
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain("Unsupported CRM provider");
    });

    it("returns default mappings for hubspot when no custom mappings exist", async () => {
      const dbMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ settings: {} }]),
            }),
          }),
        }),
      };

      const app = await createTestApp(dbMock);
      const res = await app.inject({
        method: "GET",
        url: "/crm/hubspot/mappings",
      });

      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.provider).toBe("hubspot");
      expect(data.mappings.contact.entityType).toBe("contact");
      expect(data.mappings.deal.entityType).toBe("deal");
    });
  });

  describe("PUT /crm/:provider/mappings", () => {
    it("rejects invalid mapping configuration with 400", async () => {
      const app = await createTestApp({} as any);
      const res = await app.inject({
        method: "PUT",
        url: "/crm/hubspot/mappings",
        payload: {
          contact: {
            version: 0,
            entityType: "invalid_type",
            fields: [],
          },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe("Invalid mapping configuration");
    });

    it("updates valid mapping configuration", async () => {
      let updatedSettings: any;
      const dbMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: "conn-1", settings: {} }]),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation((val) => {
            updatedSettings = val;
            return {
              where: vi.fn().mockResolvedValue([]),
            };
          }),
        }),
      };

      const app = await createTestApp(dbMock);
      const res = await app.inject({
        method: "PUT",
        url: "/crm/hubspot/mappings",
        payload: {
          contact: DEFAULT_HUBSPOT_CONTACT_MAPPING,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });
  });

  describe("POST /crm/:provider/mappings/test", () => {
    it("tests inbound contact transformation against default mapping", async () => {
      const app = await createTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/crm/hubspot/mappings/test",
        payload: {
          entityType: "contact",
          direction: "inbound",
          sampleData: {
            email: "JANE.DOE@EXAMPLE.COM ",
            firstname: "Jane",
            lastname: "Doe",
            phone: "555-1234",
            jobtitle: "CTO",
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const result = res.json().data;
      expect(result.direction).toBe("inbound");
      expect(result.output).toEqual({
        email: "jane.doe@example.com",
        firstName: "Jane",
        lastName: "Doe",
        phone: "555-1234",
        title: "CTO",
      });
      expect(result.appliedFields).toContain("email");
    });

    it("tests outbound deal transformation", async () => {
      const app = await createTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/crm/hubspot/mappings/test",
        payload: {
          entityType: "deal",
          direction: "outbound",
          sampleData: {
            name: "Enterprise License",
            amount: 75000,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const result = res.json().data;
      expect(result.direction).toBe("outbound");
      expect(result.output).toEqual({
        dealname: "Enterprise License",
        amount: "75000",
      });
    });

    it("validates required parameters", async () => {
      const app = await createTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/crm/hubspot/mappings/test",
        payload: {
          entityType: "not_a_valid_type",
          direction: "inbound",
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});

