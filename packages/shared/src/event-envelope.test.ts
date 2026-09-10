import { describe, it, expect } from "vitest";
import {
  createEvent,
  isSkoutEvent,
  SKOUT_EVENT_TYPES,
  DEXTER_EVENT_TYPES,
  SEQUENCE_EVENT_TYPES,
} from "./event-envelope.js";

describe("createEvent", () => {
  it("creates a valid SkoutEvent with all required fields", () => {
    const event = createEvent({
      type: "icp.approved",
      tenantId: "ws-123",
      aggregateId: "icp-456",
      data: { icpId: "icp-456", approvedBy: "user-1" },
    });

    expect(event.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(event.type).toBe("icp.approved");
    expect(event.version).toBe("1");
    expect(event.tenantId).toBe("ws-123");
    expect(event.aggregateId).toBe("icp-456");
    expect(event.correlationId).toBe(event.id); // new chain → correlationId = own id
    expect(typeof event.occurredAt).toBe("string");
    expect(event.data).toEqual({ icpId: "icp-456", approvedBy: "user-1" });
  });

  it("propagates an explicit correlationId (downstream event in a chain)", () => {
    const upstream = createEvent({
      type: "icp.approved",
      tenantId: "ws-1",
      aggregateId: "icp-1",
      data: {},
    });

    const downstream = createEvent({
      type: "tam.approved",
      tenantId: "ws-1",
      aggregateId: "tam-1",
      correlationId: upstream.id,
      data: {},
    });

    expect(downstream.correlationId).toBe(upstream.id);
    expect(downstream.id).not.toBe(upstream.id);
  });

  it("produces unique ids on each call", () => {
    const a = createEvent({ type: "reply.received", tenantId: "t1", aggregateId: "a1", data: {} });
    const b = createEvent({ type: "reply.received", tenantId: "t1", aggregateId: "a1", data: {} });
    expect(a.id).not.toBe(b.id);
  });
});

describe("isSkoutEvent", () => {
  it("accepts a valid SkoutEvent", () => {
    const event = createEvent({
      type: "regional_brief.approved",
      tenantId: "ws-1",
      aggregateId: "brief-1",
      data: { briefId: "brief-1" },
    });
    expect(isSkoutEvent(event)).toBe(true);
  });

  it("rejects null, primitives, and empty object", () => {
    expect(isSkoutEvent(null)).toBe(false);
    expect(isSkoutEvent(42)).toBe(false);
    expect(isSkoutEvent("string")).toBe(false);
    expect(isSkoutEvent({})).toBe(false);
  });

  it("rejects an envelope with the wrong version", () => {
    const event = createEvent({
      type: "icp.approved",
      tenantId: "ws-1",
      aggregateId: "icp-1",
      data: {},
    });
    const withWrongVersion = { ...event, version: "2" };
    expect(isSkoutEvent(withWrongVersion)).toBe(false);
  });

  it("rejects when required fields are missing", () => {
    const { correlationId: _removed, ...missingCorrelation } = createEvent({
      type: "icp.approved",
      tenantId: "ws-1",
      aggregateId: "icp-1",
      data: {},
    });
    expect(isSkoutEvent(missingCorrelation)).toBe(false);
  });
});

describe("SKOUT_EVENT_TYPES registry", () => {
  it("contains all Dexter event types", () => {
    for (const type of DEXTER_EVENT_TYPES) {
      expect((SKOUT_EVENT_TYPES as readonly string[]).includes(type)).toBe(true);
    }
  });

  it("contains all sequence event types", () => {
    for (const type of SEQUENCE_EVENT_TYPES) {
      expect((SKOUT_EVENT_TYPES as readonly string[]).includes(type)).toBe(true);
    }
  });

  it("has no duplicates", () => {
    const unique = new Set(SKOUT_EVENT_TYPES);
    expect(unique.size).toBe(SKOUT_EVENT_TYPES.length);
  });
});
