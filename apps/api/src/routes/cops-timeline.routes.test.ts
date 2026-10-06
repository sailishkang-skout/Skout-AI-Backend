import { describe, expect, it } from "vitest";
import { decodeTimelineCursor, encodeTimelineCursor } from "./cops-timeline.routes.js";

describe("timeline cursor", () => {
  const at = "2026-10-06 10:00:00.123456+00";
  const id = "0f8fbc2e-8c0a-4f6e-9b7a-2d1c3e4f5a6b";

  it("round-trips occurred_at and id", () => {
    const decoded = decodeTimelineCursor(encodeTimelineCursor(at, id));
    expect(decoded).toEqual({ occurredAt: at, id });
  });

  it("rejects a cursor that is not valid base64 JSON", () => {
    expect(decodeTimelineCursor("!!!not-a-cursor")).toBeNull();
  });

  it("rejects a cursor with a bad id", () => {
    const bad = Buffer.from(JSON.stringify({ occurred_at: at, id: "nope" })).toString("base64url");
    expect(decodeTimelineCursor(bad)).toBeNull();
  });
});
