import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../config/env.js";

const enqueueDexterEventJob = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../workers/dexter-event.queue.js", () => ({
  enqueueDexterEventJob: (...args: unknown[]) => enqueueDexterEventJob(...args),
}));

const dispatchWebhookEvent = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./webhook.service.js", () => ({
  dispatchWebhookEvent: (...args: unknown[]) => dispatchWebhookEvent(...args),
}));

const { emitSkoutEvent, isDexterSpineEvent } = await import("./skout-event.service.js");

const config = {} as Env;
const fakeDb = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("emitSkoutEvent", () => {
  it("builds a versioned envelope and enqueues it onto the dexter event queue", async () => {
    const event = await emitSkoutEvent(fakeDb, config, {
      type: "signal.detected",
      tenantId: "ws-1",
      aggregateId: "sig-1",
      data: { workspaceId: "ws-1", signalId: "sig-1" },
    });

    expect(event.id).toBeTruthy();
    expect(event.version).toBe("1");
    expect(event.tenantId).toBe("ws-1");
    expect(event.correlationId).toBe(event.id);
    expect(enqueueDexterEventJob).toHaveBeenCalledWith(config, { event });
  });

  it("threads an explicit correlationId instead of starting a new chain", async () => {
    const event = await emitSkoutEvent(fakeDb, config, {
      type: "reply.classified",
      tenantId: "ws-1",
      aggregateId: "t-1",
      correlationId: "root-event-id",
      data: {},
    });

    expect(event.correlationId).toBe("root-event-id");
    expect(event.correlationId).not.toBe(event.id);
  });

  it("dispatches an outbound webhook when a db is provided", async () => {
    const event = await emitSkoutEvent(fakeDb, config, {
      type: "opportunity.updated",
      tenantId: "ws-1",
      aggregateId: "deal-1",
      data: {},
    });

    expect(dispatchWebhookEvent).toHaveBeenCalledWith(fakeDb, config, "opportunity.updated", "ws-1", event);
  });

  it("skips webhook dispatch entirely when db is null", async () => {
    await emitSkoutEvent(null, config, {
      type: "meeting.completed",
      tenantId: "ws-1",
      aggregateId: "m-1",
      data: {},
    });

    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    expect(enqueueDexterEventJob).toHaveBeenCalled();
  });

  it("still returns the event and does not throw when the queue enqueue rejects", async () => {
    enqueueDexterEventJob.mockRejectedValueOnce(new Error("redis unreachable"));

    const event = await emitSkoutEvent(fakeDb, config, {
      type: "enrichment.completed",
      tenantId: "ws-1",
      aggregateId: "run-1",
      data: {},
    });

    expect(event.type).toBe("enrichment.completed");
    expect(dispatchWebhookEvent).toHaveBeenCalled();
  });

  it("still returns the event and does not throw when webhook dispatch rejects", async () => {
    dispatchWebhookEvent.mockRejectedValueOnce(new Error("endpoint unreachable"));

    const event = await emitSkoutEvent(fakeDb, config, {
      type: "sequence.approved",
      tenantId: "ws-1",
      aggregateId: "seq-1",
      data: {},
    });

    expect(event.type).toBe("sequence.approved");
  });
});

describe("isDexterSpineEvent", () => {
  it.each(["icp.approved", "tam.approved", "regional_brief.approved", "dexter.plan.proposed"])(
    "recognizes the pre-existing spine prefix %s",
    (type) => {
      expect(isDexterSpineEvent(type)).toBe(true);
    }
  );

  it.each([
    "signal.detected",
    "enrichment.completed",
    "sequence.approved",
    "touchpoint.completed",
    "reply.classified",
    "meeting.completed",
    "opportunity.updated",
  ])("recognizes the new GTM outcome event %s", (type) => {
    expect(isDexterSpineEvent(type)).toBe(true);
  });

  it("rejects a type that isn't part of the event spine", () => {
    expect(isDexterSpineEvent("prospect.enrolled")).toBe(false);
    expect(isDexterSpineEvent("some.random.event")).toBe(false);
  });
});
