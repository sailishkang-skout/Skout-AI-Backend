import { describe, expect, it } from "vitest";
import { earlyAccessGateEnabled } from "./early-access.js";

describe("earlyAccessGateEnabled", () => {
  it("is on in production by default", () => {
    expect(earlyAccessGateEnabled({ NODE_ENV: "production" })).toBe(true);
  });
  it("is off elsewhere by default", () => {
    expect(earlyAccessGateEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(earlyAccessGateEnabled({ NODE_ENV: "test" })).toBe(false);
  });
  it("an explicit setting wins", () => {
    expect(earlyAccessGateEnabled({ NODE_ENV: "production", EARLY_ACCESS_GATE_ENABLED: "false" })).toBe(false);
    expect(earlyAccessGateEnabled({ NODE_ENV: "development", EARLY_ACCESS_GATE_ENABLED: "true" })).toBe(true);
  });
});
