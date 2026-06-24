import { describe, expect, it } from "vitest";
import { parseCreditPacks, isRazorpayEnabled } from "./billing.service.js";

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
});
