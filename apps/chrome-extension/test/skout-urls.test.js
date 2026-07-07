import { describe, expect, it } from "vitest";
import { normalizeApiUrl, normalizeSkoutBase } from "../skout-urls.js";

describe("normalizeApiUrl", () => {
  it("strips /api/v1 suffix from CDK ApiUrl output", () => {
    expect(normalizeApiUrl("https://abc.execute-api.us-east-1.amazonaws.com/api/v1")).toBe(
      "https://abc.execute-api.us-east-1.amazonaws.com"
    );
  });

  it("keeps origin-only URLs unchanged", () => {
    expect(normalizeApiUrl("http://localhost:3001")).toBe("http://localhost:3001");
  });
});

describe("normalizeSkoutBase", () => {
  it("returns origin from full URL", () => {
    expect(normalizeSkoutBase("https://abc.execute-api.us-east-1.amazonaws.com/dashboard")).toBe(
      "https://abc.execute-api.us-east-1.amazonaws.com"
    );
  });
});
