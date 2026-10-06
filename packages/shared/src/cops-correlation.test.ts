import { describe, expect, it } from "vitest";
import { createCopsEvent } from "./copos-events.js";
import { resolveCorrelationId } from "./cops-platform.js";
import { consumeCopsEvent, type CopsProcessedStore } from "./cops-relay.js";

/**
 * Observability baseline: one correlation id travels API request -> audit row -> event envelope.
 * Consumer and provider-call propagation are not covered here.
 */
const UUID = "0f8fbc2e-8c0a-4f6e-9b7a-2d1c3e4f5a6b";

describe("resolveCorrelationId", () => {
  it("keeps a valid incoming request id, lower-cased", () => {
    expect(resolveCorrelationId(UUID.toUpperCase())).toBe(UUID);
  });

  it("takes the first value when the header is repeated", () => {
    expect(resolveCorrelationId([UUID, "11111111-1111-4111-8111-111111111111"])).toBe(UUID);
  });

  it("replaces a malformed or missing id with a fresh UUID", () => {
    const fromBad = resolveCorrelationId("not-a-uuid");
    const fromMissing = resolveCorrelationId(undefined);
    expect(fromBad).toMatch(/^[0-9a-f-]{36}$/);
    expect(fromMissing).toMatch(/^[0-9a-f-]{36}$/);
    expect(fromBad).not.toBe("not-a-uuid");
  });
});

describe("event envelope carries the correlation id", () => {
  it("createCopsEvent keeps the id it was given", () => {
    const event = createCopsEvent({
      eventType: "LifecycleTransitioned",
      tenantId: "bb214f11-bdb4-4012-add2-dd471a078981",
      aggregateType: "opportunity",
      aggregateId: "0f8fbc2e-8c0a-4f6e-9b7a-2d1c3e4f5a6c",
      actor: { type: "user", id: "6c118a84-68e0-49d2-a386-3fbf6741d4d1" },
      correlationId: UUID,
      payload: {
        dimension: "opportunity",
        entity_id: "0f8fbc2e-8c0a-4f6e-9b7a-2d1c3e4f5a6c",
        from: "qualified",
        to: "demo",
        source: "api",
        reason: "correlation check",
      },
    } as Parameters<typeof createCopsEvent>[0]);
    expect(event.correlation_id).toBe(UUID);
  });
});

describe("consumer returns the correlation id it was delivered with", () => {
  it("hands the id to the handler and back to the caller for logging", async () => {
    const seen = new Set<string>();
    const store: CopsProcessedStore = {
      insertIfAbsent: async (c, e) => {
        const k = `${c}:${e}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      },
    };
    const event = {
      event_id: "55555555-5555-4555-8555-555555555555",
      event_type: "LifecycleTransitioned",
      correlation_id: UUID,
      tenant_id: "bb214f11-bdb4-4012-add2-dd471a078981",
    };
    let handlerSawId = "";
    const first = await consumeCopsEvent(store, "notify", event, async (e) => {
      handlerSawId = e.correlation_id;
    });
    const second = await consumeCopsEvent(store, "notify", event, async () => {});
    expect(handlerSawId).toBe(UUID);
    expect(first).toEqual({ outcome: "processed", correlationId: UUID });
    expect(second).toEqual({ outcome: "duplicate", correlationId: UUID });
  });
});
