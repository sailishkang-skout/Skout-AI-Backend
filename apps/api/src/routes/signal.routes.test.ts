import { describe, expect, it, vi, beforeEach } from "vitest";
import { signalRoutes } from "./signal.routes.js";

const recordSignal = vi.fn();
vi.mock("../services/signal.service.js", () => ({
  computeSignalStackScore: vi.fn(() => ({ score: 0, band: "none" })),
  listSignalsForEntity: vi.fn(async () => []),
  listWorkspaceAccountSignals: vi.fn(async () => []),
  recordSignal: (...args: unknown[]) => recordSignal(...args),
  signalStackWeightsFromEnv: vi.fn(() => ({})),
}));

const emitSkoutEvent = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../services/skout-event.service.js", () => ({
  emitSkoutEvent: (...args: unknown[]) => emitSkoutEvent(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

/** Registers signalRoutes against a fake Fastify instance and returns the captured handlers,
 * so the route logic (including the signal.detected emission) can be exercised without a
 * real server or database — this file's routes gate every DB call behind `app.db`. */
async function registerRoutes(appDb: unknown) {
  const handlers = new Map<string, (request: unknown, reply: unknown) => unknown>();
  const fakeApp = {
    db: appDb,
    config: { SOME_CONFIG: true },
    get: (path: string, handler: (request: unknown, reply: unknown) => unknown) => handlers.set(`GET ${path}`, handler),
    post: (path: string, handler: (request: unknown, reply: unknown) => unknown) => handlers.set(`POST ${path}`, handler),
  };
  await signalRoutes(fakeApp as never);
  return handlers;
}

function makeReply() {
  const reply = {
    statusCode: 200 as number,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return reply;
}

describe("POST /signals", () => {
  it("returns 503 without a database and never emits an event", async () => {
    const handlers = await registerRoutes(null);
    const reply = makeReply();

    await handlers.get("POST /signals")!({ body: { entityId: "p-1", signalType: "manual" }, log: { warn: vi.fn() } }, reply);

    expect(reply.statusCode).toBe(503);
    expect(recordSignal).not.toHaveBeenCalled();
    expect(emitSkoutEvent).not.toHaveBeenCalled();
  });

  it("records the signal and emits signal.detected scoped to the caller's workspace", async () => {
    recordSignal.mockResolvedValue({
      id: "sig-1",
      entityType: "prospect",
      entityId: "p-1",
      signalType: "manual_tag",
    });
    const db = {};
    const handlers = await registerRoutes(db);
    const reply = makeReply();
    const request = {
      body: { entityId: "p-1", signalType: "manual_tag" },
      workspaceId: "ws-1",
      log: { warn: vi.fn() },
    };

    await handlers.get("POST /signals")!(request, reply);

    expect(reply.statusCode).toBe(201);
    expect(recordSignal).toHaveBeenCalledWith(db, expect.objectContaining({ entityId: "p-1", signalType: "manual_tag", source: "manual" }));
    expect(emitSkoutEvent).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        type: "signal.detected",
        tenantId: "ws-1",
        aggregateId: "p-1",
        data: expect.objectContaining({ signalId: "sig-1", signalType: "manual_tag" }),
      })
    );
  });

  it("rejects an invalid body with 400 before touching recordSignal or emitSkoutEvent", async () => {
    const handlers = await registerRoutes({});
    const reply = makeReply();

    await handlers.get("POST /signals")!({ body: {}, log: { warn: vi.fn() } }, reply);

    expect(reply.statusCode).toBe(400);
    expect(recordSignal).not.toHaveBeenCalled();
    expect(emitSkoutEvent).not.toHaveBeenCalled();
  });

  it("does not fail the request when emitSkoutEvent rejects", async () => {
    recordSignal.mockResolvedValue({ id: "sig-1", entityType: "prospect", entityId: "p-1", signalType: "manual_tag" });
    emitSkoutEvent.mockRejectedValueOnce(new Error("queue unavailable"));
    const handlers = await registerRoutes({});
    const reply = makeReply();
    const warn = vi.fn();

    await handlers.get("POST /signals")!(
      { body: { entityId: "p-1", signalType: "manual_tag" }, workspaceId: "ws-1", log: { warn } },
      reply
    );

    expect(reply.statusCode).toBe(201);
  });
});
