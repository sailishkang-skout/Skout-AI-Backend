import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { HttpError } from "../utils/http.js";
import { aiRoutes } from "./ai.routes.js";

const draft = {
  id: "11111111-1111-1111-1111-111111111111",
  workspaceId: "ws-1",
  prospectId: "p-1",
  threadId: null,
  enrollmentStepId: null,
  subject: "Hello",
  body: "Body",
  status: "pending_review",
  model: "openai/gpt-4o-mini",
  confidenceScore: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  reviewedAt: null,
  reviewedBy: null,
  prospectName: "Ada",
  prospectTitle: "VP Sales",
  companyName: "Acme",
  icpScore: 80,
};

const mockDrafts = {
  list: vi.fn().mockResolvedValue({ workspaceId: "ws-1", data: [draft], total: 1 }),
  getById: vi.fn().mockResolvedValue(draft),
  create: vi.fn().mockResolvedValue(draft),
  update: vi.fn().mockResolvedValue({ ...draft, subject: "Edited", status: "edited" }),
  approve: vi.fn().mockResolvedValue({ ...draft, status: "approved" }),
  reject: vi.fn().mockResolvedValue({ ...draft, status: "rejected" }),
  bulkApprove: vi.fn().mockResolvedValue({ approved: 1, skipped: 0 }),
};

vi.mock("../services/ai-draft.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/ai-draft.service.js")>(
    "../services/ai-draft.service.js"
  );
  return {
    ...actual,
    buildAiDraftService: vi.fn(() => mockDrafts),
  };
});

vi.mock("../services/ai.service.js", () => ({
  aiService: {
    generateEmail: vi.fn().mockResolvedValue({ subject: "Gen subject", html: "<p>Hi</p>" }),
  },
}));

const mockSend = vi.fn().mockResolvedValue({ sent: true, threadId: "t-1", to: "ada@acme.com" });
vi.mock("../services/ai-draft-send.service.js", () => ({
  sendApprovedDraftEmail: (...args: unknown[]) => mockSend(...args),
}));

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("config", { OPENROUTER_API_KEY: "test-key" } as never);
  app.decorate("db", {} as never);
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "validation_error", issues: error.issues });
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    reply.code(500).send({ error: String(error) });
  });
  app.addHook("preHandler", async (req) => {
    req.workspaceId = "ws-1";
    req.userId = "u-1";
  });
  await app.register(aiRoutes);
  return app;
}

describe("ai routes — draft review", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("GET /ai/drafts lists drafts", async () => {
    const res = await app.inject({ method: "GET", url: "/ai/drafts?status=pending_review" });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().data[0].prospectName).toBe("Ada");
    expect(mockDrafts.list).toHaveBeenCalledWith("ws-1", {
      status: "pending_review",
      limit: undefined,
      offset: undefined,
    });
  });

  it("GET /ai/drafts/:id returns a draft", async () => {
    const res = await app.inject({ method: "GET", url: `/ai/drafts/${draft.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(draft.id);
  });

  it("POST /ai/drafts/:id/approve approves and sends a standalone draft", async () => {
    mockDrafts.getById.mockResolvedValueOnce({
      ...draft,
      status: "sent",
      threadId: "t-1",
    });
    const res = await app.inject({ method: "POST", url: `/ai/drafts/${draft.id}/approve` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("sent");
    expect(mockDrafts.approve).toHaveBeenCalledWith("ws-1", draft.id, "u-1");
    // Standalone draft (no enrollmentStepId) is delivered on approval and marked sent.
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(res.json().send).toEqual({ sent: true, threadId: "t-1", to: "ada@acme.com" });
  });

  it("POST /ai/drafts/:id/approve skips send when draft is already sent", async () => {
    mockDrafts.approve.mockResolvedValueOnce({
      ...draft,
      status: "sent",
      threadId: "t-1",
    });
    const res = await app.inject({ method: "POST", url: `/ai/drafts/${draft.id}/approve` });
    expect(res.statusCode).toBe(200);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("POST /ai/drafts/:id/approve does not send an enrollment-linked draft", async () => {
    mockDrafts.approve.mockResolvedValueOnce({
      ...draft,
      status: "approved",
      enrollmentStepId: "estep-1",
    });
    const res = await app.inject({ method: "POST", url: `/ai/drafts/${draft.id}/approve` });
    expect(res.statusCode).toBe(200);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("POST /ai/drafts/:id/reject rejects", async () => {
    const res = await app.inject({ method: "POST", url: `/ai/drafts/${draft.id}/reject` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("rejected");
  });

  it("PATCH /ai/drafts/:id edits subject/body", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/ai/drafts/${draft.id}`,
      payload: { subject: "Edited" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("edited");
  });

  it("POST /ai/drafts/bulk-approve approves many", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ai/drafts/bulk-approve",
      payload: { ids: [draft.id] },
    });
    expect(res.statusCode).toBe(200);
    // getById mock still reports "pending_review", so no standalone send is attempted here.
    expect(res.json()).toEqual({ approved: 1, skipped: 0, sent: 0, sendFailures: [] });
  });

  it("POST /ai/drafts creates from OpenRouter when body omitted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ai/drafts",
      payload: { prospectId: "p-1", fullName: "Ada Lovelace", companyDomain: "acme.com" },
    });
    expect(res.statusCode).toBe(201);
    expect(mockDrafts.create).toHaveBeenCalled();
  });
});
