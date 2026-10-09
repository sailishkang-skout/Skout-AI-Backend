import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { Env } from "../../config/env.js";
import { createRazorpayPaymentLinkAdapter, verifyRazorpayHmac } from "./razorpay.js";

const config = (secret?: string) =>
  ({ RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: secret }) as unknown as Env;
const sign = (secret: string, raw: string) => createHmac("sha256", secret).update(raw).digest("hex");

describe("razorpay payment-link adapter", () => {
  const raw = JSON.stringify({ event: "payment_link.paid", payload: { payment_link: { entity: { id: "plink_1" } } } });

  it("rejects every webhook when no secret is configured", () => {
    const adapter = createRazorpayPaymentLinkAdapter(config(undefined));
    expect(adapter.verifyWebhook(raw, { "x-razorpay-signature": sign("anything", raw) })).toBe(false);
  });

  it("accepts only the exact signed body", () => {
    const adapter = createRazorpayPaymentLinkAdapter(config("whsec"));
    expect(adapter.verifyWebhook(raw, { "x-razorpay-signature": sign("whsec", raw) })).toBe(true);
    expect(adapter.verifyWebhook(raw + " ", { "x-razorpay-signature": sign("whsec", raw) })).toBe(false);
    expect(adapter.verifyWebhook(raw, {})).toBe(false);
    expect(verifyRazorpayHmac("whsec", raw, "short")).toBe(false);
  });

  it("parses ids and status, and falls back to a body hash when the event id header is missing", () => {
    const adapter = createRazorpayPaymentLinkAdapter(config("whsec"));
    const withHeader = adapter.parseWebhook(raw, { "x-razorpay-event-id": "evt_1" });
    expect(withHeader).toMatchObject({ eventId: "evt_1", status: "paid", providerRef: "plink_1" });
    const a = adapter.parseWebhook(raw, {});
    const b = adapter.parseWebhook(raw, {});
    expect(a!.eventId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(a!.eventId).toBe(b!.eventId);
    expect(adapter.parseWebhook("not json", {})).toBeNull();
    expect(adapter.parseWebhook(JSON.stringify({ event: "order.paid" }), {})!.status).toBeNull();
  });

  it("creates a link with notifications off and returns the hosted URL", async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createRazorpayPaymentLinkAdapter(config("whsec"), (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: "plink_9", short_url: "https://rzp.io/i/x", status: "created" }));
    }) as unknown as typeof fetch);
    const link = await adapter.createPaymentLink({ amountMinor: 5000, currency: "INR", description: "d", referenceId: "r", notes: { a: "b" } });
    expect(link).toEqual({ providerRef: "plink_9", checkoutUrl: "https://rzp.io/i/x" });
    expect(sent).toMatchObject({ amount: 5000, currency: "INR", reference_id: "r", notify: { sms: false, email: false } });
  });
});
