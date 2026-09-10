import { describe, expect, it } from "vitest";
import { signToken, verifyToken } from "./signed-token.js";

describe("signed-token", () => {
  it("round-trips a payload", () => {
    const token = signToken({ enrollmentId: "e1", url: "https://example.com" }, "secret");
    const decoded = verifyToken<{ enrollmentId: string; url: string }>(token, "secret");
    expect(decoded).toEqual({ enrollmentId: "e1", url: "https://example.com" });
  });

  it("rejects a token signed with a different secret", () => {
    const token = signToken({ a: 1 }, "secret-a");
    expect(verifyToken(token, "secret-b")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signToken({ amount: 1 }, "secret");
    const [, sig] = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ amount: 999 }), "utf8").toString("base64url");
    expect(verifyToken(`${tamperedPayload}.${sig}`, "secret")).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyToken("not-a-valid-token", "secret")).toBeNull();
    expect(verifyToken("a.b.c", "secret")).toBeNull();
    expect(verifyToken("", "secret")).toBeNull();
  });

  it("rejects a token with invalid base64 payload", () => {
    expect(verifyToken("!!!not-base64!!!.sig", "secret")).toBeNull();
  });
});
