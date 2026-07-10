import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../lib/redis.js", () => ({
  isRedisAvailable: vi.fn().mockResolvedValue(true),
  redisBullMqConnection: vi.fn().mockReturnValue({ host: "localhost", port: 6379 }),
}));

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@skout/db", () => ({
  createDb: vi.fn().mockReturnValue({
    db: {},
    sql: { end: vi.fn().mockResolvedValue(undefined) },
  }),
  schema: {
    webhookDeliveries: "webhookDeliveries",
  },
}));

vi.mock("./webhook-delivery.queue.js", () => ({
  WEBHOOK_DELIVERY_QUEUE: "skout-webhook-delivery",
  enqueueWebhookDelivery: vi.fn().mockResolvedValue(undefined),
  getWebhookDeliveryQueue: vi.fn().mockReturnValue({
    add: vi.fn().mockResolvedValue({}),
  }),
}));

import { signPayload, verifySignature } from "./webhook-delivery.worker.js";

describe("signPayload", () => {
  it("produces a sha256= prefixed hex string", () => {
    const sig = signPayload("mysecret", 1700000000, '{"hello":"world"}');
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it("is deterministic for same inputs", () => {
    const a = signPayload("s", 1, "body");
    const b = signPayload("s", 1, "body");
    expect(a).toBe(b);
  });

  it("differs for different secrets", () => {
    expect(signPayload("secret1", 1, "body")).not.toBe(signPayload("secret2", 1, "body"));
  });

  it("differs for different timestamps", () => {
    expect(signPayload("s", 1, "body")).not.toBe(signPayload("s", 2, "body"));
  });
});

describe("verifySignature", () => {
  it("returns true for a valid signature within tolerance", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const body = '{"test":true}';
    const sig = signPayload("secret", nowSec, body);
    expect(verifySignature("secret", nowSec, body, sig)).toBe(true);
  });

  it("returns false for wrong secret", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const body = "body";
    const sig = signPayload("right", nowSec, body);
    expect(verifySignature("wrong", nowSec, body, sig)).toBe(false);
  });

  it("returns false when timestamp is outside tolerance", () => {
    const staleSec = Math.floor(Date.now() / 1000) - 400;
    const body = "body";
    const sig = signPayload("s", staleSec, body);
    expect(verifySignature("s", staleSec, body, sig, 300)).toBe(false);
  });
});
