import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyRsvpWebhookSignature } from "./webhook-signature.js";

describe("verifyRsvpWebhookSignature", () => {
  it("returns true for a correctly signed payload", () => {
    const secret = "test-secret";
    const rawBody = JSON.stringify({ meetingId: "m-1" });
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
    expect(verifyRsvpWebhookSignature(rawBody, signature, secret)).toBe(true);
  });

  it("returns false for a tampered payload", () => {
    const secret = "test-secret";
    const signature = createHmac("sha256", secret).update("original").digest("hex");
    expect(verifyRsvpWebhookSignature("tampered", signature, secret)).toBe(false);
  });

  it("returns false for a mismatched-length signature without throwing", () => {
    expect(verifyRsvpWebhookSignature("body", "short", "secret")).toBe(false);
  });
});
