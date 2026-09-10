import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { webhookRoutes } from "./webhooks.routes.js";

// ---------------------------------------------------------------------------
// Mock the webhook service so tests don't need a real DB
// ---------------------------------------------------------------------------

const mockEndpoint = {
  id: "ep-1",
  workspaceId: "ws-1",
  url: "https://example.com/hook",
  description: "Test endpoint",
  enabled: true,
  eventTypes: ["prospect.enrolled"],
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
};

const mockSvc = {
  listEndpoints: vi.fn().mockResolvedValue([mockEndpoint]),
  getEndpoint: vi.fn().mockResolvedValue(mockEndpoint),
  createEndpoint: vi.fn().mockResolvedValue({ ...mockEndpoint, secret: "abc123" }),
  updateEndpoint: vi.fn().mockResolvedValue(mockEndpoint),
  deleteEndpoint: vi.fn().mockResolvedValue(true),
  rotateSecret: vi.fn().mockResolvedValue("newsecret"),
  listDeliveries: vi.fn().mockResolvedValue([]),
};

vi.mock("../services/webhook.service.js", () => ({
  WEBHOOK_EVENT_TYPES: ["prospect.enrolled", "sequence.step.completed", "reply.received"],
  buildWebhookService: vi.fn(() => mockSvc),
}));

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorate("config", {} as never);
  app.decorate("db", {} as never);

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "validation_error", issues: error.issues });
    }
    reply.code(500).send({ error: String(error) });
  });

  app.addHook("preHandler", async (req) => {
    req.workspaceId = "ws-1";
  });

  await app.register(webhookRoutes);
  return app;
}

describe("webhooks routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("GET /webhooks/event-types returns supported types", async () => {
    const res = await app.inject({ method: "GET", url: "/webhooks/event-types" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toContain("prospect.enrolled");
    expect(res.json().data).toContain("reply.received");
  });

  it("GET /webhooks/endpoints returns endpoint list", async () => {
    const res = await app.inject({ method: "GET", url: "/webhooks/endpoints" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].id).toBe("ep-1");
  });

  it("POST /webhooks/endpoints creates an endpoint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/endpoints",
      payload: { url: "https://example.com/hook", eventTypes: ["prospect.enrolled"] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: "ep-1", secret: "abc123" });
  });

  it("POST /webhooks/endpoints rejects invalid URL", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/endpoints",
      payload: { url: "not-a-url", eventTypes: ["prospect.enrolled"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /webhooks/endpoints rejects empty eventTypes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/endpoints",
      payload: { url: "https://example.com/hook", eventTypes: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /webhooks/endpoints rejects unknown event type", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/endpoints",
      payload: { url: "https://example.com/hook", eventTypes: ["unknown.event"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /webhooks/endpoints/:id returns endpoint", async () => {
    const res = await app.inject({ method: "GET", url: "/webhooks/endpoints/ep-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("ep-1");
  });

  it("GET /webhooks/endpoints/:id returns 404 when not found", async () => {
    mockSvc.getEndpoint.mockResolvedValueOnce(null);
    const res = await app.inject({ method: "GET", url: "/webhooks/endpoints/missing" });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH /webhooks/endpoints/:id updates endpoint", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/webhooks/endpoints/ep-1",
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(mockSvc.updateEndpoint).toHaveBeenCalledWith("ep-1", "ws-1", { enabled: false });
  });

  it("PATCH /webhooks/endpoints/:id returns 404 when not found", async () => {
    mockSvc.updateEndpoint.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "PATCH",
      url: "/webhooks/endpoints/missing",
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /webhooks/endpoints/:id deletes endpoint", async () => {
    const res = await app.inject({ method: "DELETE", url: "/webhooks/endpoints/ep-1" });
    expect(res.statusCode).toBe(204);
  });

  it("DELETE /webhooks/endpoints/:id returns 404 when not found", async () => {
    mockSvc.deleteEndpoint.mockResolvedValueOnce(false);
    const res = await app.inject({ method: "DELETE", url: "/webhooks/endpoints/missing" });
    expect(res.statusCode).toBe(404);
  });

  it("POST /webhooks/endpoints/:id/rotate-secret returns new secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/endpoints/ep-1/rotate-secret",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().secret).toBe("newsecret");
  });

  it("GET /webhooks/endpoints/:id/deliveries returns delivery log", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/webhooks/endpoints/ep-1/deliveries",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it("GET /webhooks/endpoints/:id/deliveries returns 404 when endpoint not found", async () => {
    mockSvc.getEndpoint.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "GET",
      url: "/webhooks/endpoints/missing/deliveries",
    });
    expect(res.statusCode).toBe(404);
  });
});
