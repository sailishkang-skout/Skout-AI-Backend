import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../config/env.js";

const queueAdd = vi.fn(async () => ({}));
const queueOn = vi.fn();
const QueueCtor = vi.fn().mockImplementation((name: string, opts: unknown) => ({
  name,
  opts,
  add: queueAdd,
  on: queueOn,
}));
vi.mock("bullmq", () => ({ Queue: QueueCtor }));

const { emitSkoutEvent } = await import("./skout-event.service.js");

beforeEach(() => {
  queueAdd.mockClear();
  queueOn.mockClear();
  // QueueCtor itself is intentionally not reset — the module under test caches a single
  // queue instance for the process lifetime (mirrors apps/api's dexter-event.queue.ts), so
  // only the first test that supplies a REDIS_URL actually constructs it.
});

describe("emitSkoutEvent (apps/crm)", () => {
  it("skips enqueueing and still returns a well-formed event when REDIS_URL is unset", async () => {
    const config = {} as Env;

    const event = await emitSkoutEvent(config, {
      type: "meeting.completed",
      tenantId: "ws-1",
      aggregateId: "meeting-1",
      data: { outcome: "held" },
    });

    expect(event.id).toBeTruthy();
    expect(event.type).toBe("meeting.completed");
    expect(event.tenantId).toBe("ws-1");
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("enqueues onto the shared skout-dexter-event queue when REDIS_URL is set", async () => {
    const config = { REDIS_URL: "redis://localhost:6379" } as Env;

    const event = await emitSkoutEvent(config, {
      type: "opportunity.updated",
      tenantId: "ws-1",
      aggregateId: "deal-1",
      data: { dealId: "deal-1" },
    });

    expect(QueueCtor).toHaveBeenCalledWith("skout-dexter-event", expect.anything());
    expect(queueAdd).toHaveBeenCalledWith("process-event", { event }, { jobId: event.id });
  });

  it("does not throw when the queue add rejects", async () => {
    queueAdd.mockRejectedValueOnce(new Error("redis connection refused"));
    const config = { REDIS_URL: "redis://localhost:6379" } as Env;

    const event = await emitSkoutEvent(config, {
      type: "opportunity.updated",
      tenantId: "ws-1",
      aggregateId: "deal-2",
      data: {},
    });

    expect(event.type).toBe("opportunity.updated");
  });
});
