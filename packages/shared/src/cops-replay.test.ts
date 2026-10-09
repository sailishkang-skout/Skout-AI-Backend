import { describe, expect, it } from "vitest";
import { buildCopsReplayPlan, CopsReplayValidationError, COPS_REPLAY_MAX_EVENTS } from "./cops-replay.js";

const id = "6f1c2a7e-8b1d-4c2e-9f3a-1a2b3c4d5e6f";

describe("buildCopsReplayPlan", () => {
  it("accepts replay by event ids and de-duplicates them", () => {
    const plan = buildCopsReplayPlan({ tenantId: "ws_1", eventIds: [id, id] });
    expect(plan).toEqual({ kind: "ids", tenantId: "ws_1", eventIds: [id] });
  });

  it("accepts replay by a time range", () => {
    const plan = buildCopsReplayPlan({
      tenantId: "ws_1",
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-10-02T00:00:00Z"),
    });
    expect(plan.kind).toBe("range");
    expect(plan).toMatchObject({ limit: COPS_REPLAY_MAX_EVENTS });
  });

  it("rejects both ids and a range, or neither", () => {
    expect(() =>
      buildCopsReplayPlan({ tenantId: "ws_1", eventIds: [id], from: new Date(), to: new Date() })
    ).toThrow(CopsReplayValidationError);
    expect(() => buildCopsReplayPlan({ tenantId: "ws_1" })).toThrow(CopsReplayValidationError);
  });

  it("rejects a reversed or half-open range", () => {
    expect(() =>
      buildCopsReplayPlan({ tenantId: "ws_1", from: new Date("2026-10-02"), to: new Date("2026-10-01") })
    ).toThrow(/before/);
    expect(() => buildCopsReplayPlan({ tenantId: "ws_1", from: new Date("2026-10-01") })).toThrow(/both/);
  });

  it("rejects malformed ids and oversized batches", () => {
    expect(() => buildCopsReplayPlan({ tenantId: "ws_1", eventIds: ["nope"] })).toThrow(/valid event id/);
    const many = Array.from({ length: COPS_REPLAY_MAX_EVENTS + 1 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
    );
    expect(() => buildCopsReplayPlan({ tenantId: "ws_1", eventIds: many })).toThrow(/At most/);
  });

  it("requires a tenant", () => {
    expect(() => buildCopsReplayPlan({ tenantId: "", eventIds: [id] })).toThrow(/tenantId/);
  });
});
