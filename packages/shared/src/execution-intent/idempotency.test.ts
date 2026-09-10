import { describe, expect, it } from "vitest";
import { buildIdempotencyKey } from "./idempotency.js";

describe("buildIdempotencyKey", () => {
  it("joins parts with a colon delimiter", () => {
    expect(buildIdempotencyKey("run-1", "node-a")).toBe("run-1:node-a");
  });

  it("supports any number of parts", () => {
    expect(buildIdempotencyKey("a", "b", "c", "d")).toBe("a:b:c:d");
  });

  it("is deterministic for the same inputs", () => {
    expect(buildIdempotencyKey("x", "y")).toBe(buildIdempotencyKey("x", "y"));
  });
});
