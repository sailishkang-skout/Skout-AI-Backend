import { createHmac, timingSafeEqual } from "node:crypto";

/** Same HMAC-SHA256 + timingSafeEqual pattern as apps/api's billing.service.ts Razorpay webhook. */
export function verifyRsvpWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
