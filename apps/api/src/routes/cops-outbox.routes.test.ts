import { describe, expect, it } from "vitest";
import { COPS_REPLAY_BODY_SCHEMA } from "./cops-outbox.routes.js";

describe("COPS_REPLAY_BODY_SCHEMA", () => {
  it("accepts replay by ids with a reason", () => {
    expect(
      COPS_REPLAY_BODY_SCHEMA.safeParse({
        event_ids: ["d06a12e4-628b-437f-8f96-1f23c7823658"],
        reason: "Retry after consumer fix",
      }).success
    ).toBe(true);
  });

  it("accepts replay by a complete time range with a reason", () => {
    expect(
      COPS_REPLAY_BODY_SCHEMA.safeParse({
        from: "2026-10-06T10:00:00.000Z",
        to: "2026-10-06T11:00:00.000Z",
        reason: "Retry after consumer fix",
      }).success
    ).toBe(true);
  });

  it("rejects missing, mixed, or incomplete selectors and short reasons", () => {
    const eventId = "d06a12e4-628b-437f-8f96-1f23c7823658";
    expect(COPS_REPLAY_BODY_SCHEMA.safeParse({ reason: "because it failed" }).success).toBe(false);
    expect(
      COPS_REPLAY_BODY_SCHEMA.safeParse({
        event_ids: [eventId],
        from: "2026-10-06T10:00:00.000Z",
        to: "2026-10-06T11:00:00.000Z",
        reason: "because it failed",
      }).success
    ).toBe(false);
    expect(
      COPS_REPLAY_BODY_SCHEMA.safeParse({
        from: "2026-10-06T10:00:00.000Z",
        reason: "because it failed",
      }).success
    ).toBe(false);
    expect(
      COPS_REPLAY_BODY_SCHEMA.safeParse({
        event_ids: [eventId],
        reason: "short",
      }).success
    ).toBe(false);
  });

  it("caps explicit replay selections at 1,000 events", () => {
    const eventIds = Array.from({ length: 1_001 }, (_, index) => {
      const tail = String(index + 1).padStart(12, "0");
      return `d06a12e4-628b-437f-8f96-${tail}`;
    });
    expect(
      COPS_REPLAY_BODY_SCHEMA.safeParse({ event_ids: eventIds, reason: "Retry after consumer fix" }).success
    ).toBe(false);
  });
});
