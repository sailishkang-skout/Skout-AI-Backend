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
