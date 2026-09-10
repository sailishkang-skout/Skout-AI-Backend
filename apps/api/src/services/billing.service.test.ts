import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBillingService, parseCreditPacks, isRazorpayEnabled } from "./billing.service.js";

describe("billing.service", () => {
  it("returns default packs when JSON invalid", () => {
    const packs = parseCreditPacks("not-json");
    expect(packs.length).toBeGreaterThan(0);
    expect(packs[0]).toMatchObject({ id: expect.any(String), credits: expect.any(Number) });
  });

  it("detects razorpay enabled from env keys", () => {
    expect(isRazorpayEnabled({ RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s" } as never)).toBe(true);
    expect(isRazorpayEnabled({} as never)).toBe(false);
  });

  it("verifies the Razorpay checkout signature over `${orderId}|${paymentId}`", () => {
    const config = { RAZORPAY_KEY_ID: "key", RAZORPAY_KEY_SECRET: "secret" } as never;
    const billing = createBillingService({} as never, config);
    const orderId = "order_123";
    const paymentId = "pay_456";
    const valid = createHmac("sha256", "secret").update(`${orderId}|${paymentId}`).digest("hex");

    expect(billing.verifyCheckoutSignature(orderId, paymentId, valid)).toBe(true);
    expect(billing.verifyCheckoutSignature(orderId, paymentId, "deadbeef")).toBe(false);
  });

  it("rejects checkout signatures when no key secret is configured", () => {
    const billing = createBillingService({} as never, {} as never);
    expect(billing.verifyCheckoutSignature("o", "p", "anything")).toBe(false);
  });
});
