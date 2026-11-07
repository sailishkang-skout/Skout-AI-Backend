import { describe, expect, it } from "vitest";
import { customerOpsBaseUrl } from "./team.routes.js";

describe("customerOpsBaseUrl", () => {
  it("uses COPS_APP_URL when set", () => {
    expect(customerOpsBaseUrl("https://ops-stg.skoutai.io/", "https://evil.example")).toBe("https://ops-stg.skoutai.io");
  });
  it("falls back to a Skout or localhost origin", () => {
    expect(customerOpsBaseUrl(undefined, "https://ops-stg.skoutai.io")).toBe("https://ops-stg.skoutai.io");
    expect(customerOpsBaseUrl(undefined, "http://localhost:3400")).toBe("http://localhost:3400");
  });
  it("never points an email link at another site", () => {
    expect(customerOpsBaseUrl(undefined, "https://skoutai.io.evil.example")).toBeNull();
    expect(customerOpsBaseUrl(undefined, "http://ops.skoutai.io")).toBeNull();
    expect(customerOpsBaseUrl(undefined, undefined)).toBeNull();
  });
});
