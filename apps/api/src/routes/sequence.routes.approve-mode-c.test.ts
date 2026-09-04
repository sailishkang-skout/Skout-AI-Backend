import { describe, expect, it, vi, beforeEach } from "vitest";

const approveModeC = vi.fn();
vi.mock("../services/sequence.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/sequence.service.js")>(
    "../services/sequence.service.js"
  );
  return {
    ...actual,
    buildSequenceService: vi.fn((db: unknown) => (db ? { approveModeC } : null)),
  };
});

const emitSkoutEvent = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../services/skout-event.service.js", () => ({
  emitSkoutEvent: (...args: unknown[]) => emitSkoutEvent(...args),
}));

vi.mock("../services/webhook.service.js", () => ({
  dispatchWebhookEvent: vi.fn(async () => {}),
}));

const { sequenceRoutes } = await import("./sequence.routes.js");

beforeEach(() => {
  vi.clearAllMocks();
});

/** Registers sequenceRoutes against a fake Fastify instance and returns the captured handlers —
 * a DB-independent unit test for the approve-mode-c → sequence.approved emission, since
 * sequence.routes.test.ts's coverage of this same route requires a real database connection. */
async function registerRoutes(appDb: unknown) {
  const handlers = new Map<string, (request: unknown, reply: unknown) => unknown>();
  const fakeApp = {
    db: appDb,
    config: { SOME_CONFIG: true },
    get: (path: string, handler: never) => handlers.set(`GET ${path}`, handler),
    post: (path: string, handler: never) => handlers.set(`POST ${path}`, handler),
    patch: (path: string, handler: never) => handlers.set(`PATCH ${path}`, handler),
    put: (path: string, handler: never) => handlers.set(`PUT ${path}`, handler),
    delete: (path: string, handler: never) => handlers.set(`DELETE ${path}`, handler),
  };
  await sequenceRoutes(fakeApp as never);
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

describe("POST /sequences/:id/approve-mode-c", () => {
  it("emits sequence.approved with the sequence's mode and the approving user", async () => {
    approveModeC.mockResolvedValue({ id: "seq-1", mode: "C", modeCApprovedAt: new Date(), modeCApprovedBy: "user-1" });
    const db = {};
    const handlers = await registerRoutes(db);
    const reply = makeReply();
    const request = { params: { id: "seq-1" }, workspaceId: "ws-1", userId: "user-1", log: { warn: vi.fn() } };

    await handlers.get("POST /sequences/:id/approve-mode-c")!(request, reply);

    expect(reply.statusCode).toBe(200);
    expect(emitSkoutEvent).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        type: "sequence.approved",
        tenantId: "ws-1",
        aggregateId: "seq-1",
        data: expect.objectContaining({ sequenceId: "seq-1", mode: "C", approvedBy: "user-1" }),
      })
    );
  });

  it("does not emit an event when the sequence does not exist", async () => {
    approveModeC.mockResolvedValue(null);
    const handlers = await registerRoutes({});
    const reply = makeReply();

    await handlers.get("POST /sequences/:id/approve-mode-c")!(
      { params: { id: "missing" }, workspaceId: "ws-1", userId: "user-1", log: { warn: vi.fn() } },
      reply
    );

    expect(reply.statusCode).toBe(404);
    expect(emitSkoutEvent).not.toHaveBeenCalled();
  });

  it("returns 503 without a database and never emits an event", async () => {
    const handlers = await registerRoutes(null);
    const reply = makeReply();

    await handlers.get("POST /sequences/:id/approve-mode-c")!(
      { params: { id: "seq-1" }, workspaceId: "ws-1", userId: "user-1", log: { warn: vi.fn() } },
      reply
    );

    expect(reply.statusCode).toBe(503);
    expect(emitSkoutEvent).not.toHaveBeenCalled();
  });
});
