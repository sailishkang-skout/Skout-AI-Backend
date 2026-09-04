import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../services/policy-gateway.service.js", () => ({
  AUTOMATION_MODES: ["ask", "auto", "draft", "approve"],
  classifyAndRecord: vi.fn(),
  listDecisions: vi.fn(async () => []),
  listPolicies: vi.fn(async () => []),
  upsertActionMode: vi.fn(),
}));
vi.mock("../services/decision-workflow.service.js", () => ({
  completeWorkflowRun: vi.fn(),
  createDecisionFromNba: vi.fn(),
  decideView: vi.fn(),
  getDecisionView: vi.fn(),
  getWorkflowRun: vi.fn(),
  listDecisionViews: vi.fn(async () => []),
  listWorkflowRuns: vi.fn(async () => []),
  startWorkflowRun: vi.fn(),
}));
vi.mock("../services/dexter-command-center.service.js", () => ({
  getDexterCommandCenter: vi.fn(),
  listDexterPlans: vi.fn(),
}));
vi.mock("../services/regional-tam-gate.service.js", () => ({
  getRegionalTamGate: vi.fn(),
  seedDemoWinLossDeals: vi.fn(),
}));

const rejectDexterPlan = vi.fn();
const invokeDexterPlan = vi.fn();
vi.mock("../services/dexter-journey.service.js", () => ({
  approveDexterPlan: vi.fn(),
  checkLinkedinVoiceEligibility: vi.fn(),
  confirmLinkedinVoiceSent: vi.fn(),
  createLinkedinVoiceHandoff: vi.fn(),
  draftLinkedinVoiceScript: vi.fn(),
  getLinkedinVoiceHandoff: vi.fn(),
  invokeDexterPlan: (...args: unknown[]) => invokeDexterPlan(...args),
  listLinkedinVoiceHandoffs: vi.fn(),
  proposeDexterPlan: vi.fn(),
  recordDexterLearning: vi.fn(),
  rejectDexterPlan: (...args: unknown[]) => rejectDexterPlan(...args),
  synthesizeVoiceAudio: vi.fn(),
}));

const { dexterPlatformRoutes } = await import("./dexter-platform.routes.js");

beforeEach(() => {
  vi.clearAllMocks();
});

/** Registers dexterPlatformRoutes against a fake Fastify instance and returns the captured
 * handlers — same DB-independent unit-test pattern as signal.routes.test.ts. */
async function registerRoutes(appDb: unknown) {
  const handlers = new Map<string, (request: unknown, reply: unknown) => unknown>();
  const fakeApp = {
    db: appDb,
    config: { SOME_CONFIG: true },
    get: (path: string, handler: never) => handlers.set(`GET ${path}`, handler),
    post: (path: string, handler: never) => handlers.set(`POST ${path}`, handler),
    put: (path: string, handler: never) => handlers.set(`PUT ${path}`, handler),
    delete: (path: string, handler: never) => handlers.set(`DELETE ${path}`, handler),
  };
  await dexterPlatformRoutes(fakeApp as never);
  return handlers;
}

function makeReply() {
  const reply = {
    statusCode: 200 as number,
    body: undefined as unknown,
    code(c: number) {
      this.statusCode = c;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return reply;
}

describe("POST /dexter/plans/:id/reject", () => {
  it("401s without a workspaceId", async () => {
    const handlers = await registerRoutes({});
    const reply = makeReply();
    await handlers.get("POST /dexter/plans/:id/reject")!({ params: { id: "plan-1" }, body: {} }, reply);
    expect(reply.statusCode).toBe(401);
    expect(rejectDexterPlan).not.toHaveBeenCalled();
  });

  it("400s on an invalid body", async () => {
    const handlers = await registerRoutes({});
    const reply = makeReply();
    await handlers.get("POST /dexter/plans/:id/reject")!(
      { params: { id: "11111111-1111-4111-8111-111111111111" }, workspaceId: "ws-1", body: { reason: 12345 } },
      reply
    );
    expect(reply.statusCode).toBe(400);
    expect(rejectDexterPlan).not.toHaveBeenCalled();
  });

  it("forwards to rejectDexterPlan with the parsed id, userId, and reason", async () => {
    rejectDexterPlan.mockResolvedValue({ id: "plan-1", status: "rejected" });
    const config = { SOME_CONFIG: true };
    const db = {};
    const handlers = new Map<string, (request: unknown, reply: unknown) => unknown>();
    const fakeApp = { db, config, get: vi.fn(), put: vi.fn(), post: (p: string, h: never) => handlers.set(`POST ${p}`, h) };
    await dexterPlatformRoutes(fakeApp as never);
    const reply = makeReply();

    await handlers.get("POST /dexter/plans/:id/reject")!(
      {
        params: { id: "11111111-1111-4111-8111-111111111111" },
        workspaceId: "ws-1",
        userId: "user-1",
        body: { reason: "not a fit" },
      },
      reply
    );

    expect(rejectDexterPlan).toHaveBeenCalledWith(db, config, "ws-1", "11111111-1111-4111-8111-111111111111", "user-1", "not a fit");
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ data: { id: "plan-1", status: "rejected" } });
  });
});

describe("POST /dexter/plans/:id/invoke", () => {
  it("forwards without a sequenceId when none is given (backward compatible)", async () => {
    invokeDexterPlan.mockResolvedValue({ plan: { id: "plan-1", status: "invoked" } });
    const handlers = await registerRoutes({});
    const reply = makeReply();

    await handlers.get("POST /dexter/plans/:id/invoke")!(
      { params: { id: "11111111-1111-4111-8111-111111111111" }, workspaceId: "ws-1", userId: "user-1", body: {} },
      reply
    );

    expect(invokeDexterPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "ws-1",
      "11111111-1111-4111-8111-111111111111",
      "user-1",
      undefined
    );
  });

  it("forwards the sequenceId when given", async () => {
    invokeDexterPlan.mockResolvedValue({ plan: { id: "plan-1", status: "invoked" } });
    const handlers = await registerRoutes({});
    const reply = makeReply();

    await handlers.get("POST /dexter/plans/:id/invoke")!(
      {
        params: { id: "11111111-1111-4111-8111-111111111111" },
        workspaceId: "ws-1",
        userId: "user-1",
        body: { sequenceId: "22222222-2222-4222-8222-222222222222" },
      },
      reply
    );

    expect(invokeDexterPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "ws-1",
      "11111111-1111-4111-8111-111111111111",
      "user-1",
      { sequenceId: "22222222-2222-4222-8222-222222222222" }
    );
  });

  it("400s when sequenceId is not a valid UUID", async () => {
    const handlers = await registerRoutes({});
    const reply = makeReply();

    await handlers.get("POST /dexter/plans/:id/invoke")!(
      {
        params: { id: "11111111-1111-4111-8111-111111111111" },
        workspaceId: "ws-1",
        userId: "user-1",
        body: { sequenceId: "not-a-uuid" },
      },
      reply
    );

    expect(reply.statusCode).toBe(400);
    expect(invokeDexterPlan).not.toHaveBeenCalled();
  });
});
