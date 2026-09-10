import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { httpActionNodeHandler } from "./action-http.node.js";

describe("httpActionNodeHandler", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ hello: "world" }) })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("makes the configured request and returns status + body", async () => {
    const result = await httpActionNodeHandler({
      db: {} as any,
      config: {} as any,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: false,
      node: { id: "n1", type: "action_http", config: { url: "https://example.com/hook", method: "POST", body: { a: 1 } } },
      priorOutputs: {},
    });
    expect(result.output.status).toBe(200);
    expect(result.output.body).toEqual({ hello: "world" });
  });

  it("does not call fetch when isSimulation is true", async () => {
    const result = await httpActionNodeHandler({
      db: {} as any,
      config: {} as any,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: true,
      node: { id: "n1", type: "action_http", config: { url: "https://example.com/hook", method: "POST" } },
      priorOutputs: {},
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.output.simulated).toBe(true);
  });
});

describe("httpActionNodeHandler — ambiguous outcomes", () => {
  const baseCtx = { db: {} as never, config: {} as never, workspaceId: "ws-1", runId: "run-1", isSimulation: false, priorOutputs: {} };

  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks a 5xx response as ambiguous rather than a clean failure", async () => {
    vi.mocked(global.fetch).mockResolvedValue({ status: 502, json: async () => ({ error: "bad gateway" }) } as never);
    const result = await httpActionNodeHandler({ ...baseCtx, node: { id: "n1", type: "action_http", config: { url: "https://example.com" } } });
    expect(result.outcome).toBe("ambiguous");
  });

  it("marks a network/timeout error as ambiguous", async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error("fetch failed: timeout"));
    await expect(
      httpActionNodeHandler({ ...baseCtx, node: { id: "n1", type: "action_http", config: { url: "https://example.com" } } })
    ).rejects.toMatchObject({ outcome: "ambiguous" });
  });

  it("does not mark a clean 2xx response as ambiguous", async () => {
    vi.mocked(global.fetch).mockResolvedValue({ status: 200, json: async () => ({ ok: true }) } as never);
    const result = await httpActionNodeHandler({ ...baseCtx, node: { id: "n1", type: "action_http", config: { url: "https://example.com" } } });
    expect(result.outcome).toBeUndefined();
  });

  it("does not mark a clean 4xx response as ambiguous — that's a real, non-retryable client error", async () => {
    vi.mocked(global.fetch).mockResolvedValue({ status: 404, json: async () => ({ error: "not found" }) } as never);
    const result = await httpActionNodeHandler({ ...baseCtx, node: { id: "n1", type: "action_http", config: { url: "https://example.com" } } });
    expect(result.outcome).toBeUndefined();
  });
});
