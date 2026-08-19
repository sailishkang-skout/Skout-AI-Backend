import { describe, expect, it } from "vitest";
import {
  normalizeApiUrl,
  normalizeSkoutBase,
  PRODUCTION_API_URL,
  PRODUCTION_WEB_URL,
  skoutTabPatterns,
  urlMatchesSkoutWeb,
} from "../skout-urls.js";

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

describe("production origins", () => {
  it("exposes store default URLs", () => {
    expect(PRODUCTION_WEB_URL).toBe("https://www.skoutai.io");
    expect(PRODUCTION_API_URL).toMatch(/execute-api\.us-east-1\.amazonaws\.com$/);
  });

  it("matches skoutai.io tabs without custom config", () => {
    expect(urlMatchesSkoutWeb("https://www.skoutai.io/app/signin")).toBe(true);
    expect(skoutTabPatterns().some((p) => p.includes("skoutai.io"))).toBe(true);
  });
});
