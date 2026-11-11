import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Env } from "../../config/env.js";
import type { PspAdapter, PspPaymentLink, PspWebhookEvent } from "./psp-adapter.js";

/**
 * Razorpay helpers shared by the credit-pack billing flow (billing.service.ts) and the COPS-03
 * payment-link adapter, so there is one place for the API auth header and the HMAC check.
 */
const RAZORPAY_API = "https://api.razorpay.com/v1";

export function razorpayAuthHeader(keyId: string, keySecret: string): string {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
}

/** HMAC-SHA256(payload, secret) compared in constant time. */
export function verifyRazorpayHmac(secret: string, payload: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

type FetchLike = typeof fetch;

/** Webhook entity shapes we read. Only ids, status and amounts are taken from them. */
interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    payment_link?: { entity?: { id?: string; status?: string; amount?: number; amount_paid?: number; currency?: string } };
    payment?: { entity?: { id?: string; order_id?: string; status?: string; amount?: number; currency?: string; notes?: Record<string, unknown> } };
    refund?: { entity?: { id?: string; payment_id?: string; amount?: number; currency?: string } };
  };
}

const STATUS_BY_EVENT: Record<string, PspWebhookEvent["status"]> = {
  "payment_link.paid": "paid",
  "payment_link.expired": "expired",
  "payment_link.cancelled": "cancelled",
  "payment.failed": "failed",
  "refund.processed": "refunded",
};

/**
 * Payment requests through Razorpay Payment Links (provider-hosted checkout). Uses the same
 * RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET as credit-pack billing.
 */
export function createRazorpayPaymentLinkAdapter(config: Env, fetchImpl: FetchLike = fetch): PspAdapter {
  /** The merchant balance refunds are paid from; null when Razorpay does not answer. */
  async function getBalance(): Promise<{ balanceMinor: number; currency: string } | null> {
    const res = await fetchImpl(`${RAZORPAY_API}/balance`, { headers: { Authorization: razorpayAuthHeader(config.RAZORPAY_KEY_ID!, config.RAZORPAY_KEY_SECRET!) } }).catch(() => null);
    if (!res?.ok) return null;
    const body = (await res.json().catch(() => null)) as { balance?: number; currency?: string } | null;
    return typeof body?.balance === "number" ? { balanceMinor: body.balance, currency: body.currency ?? "INR" } : null;
  }

  return {
    provider: "razorpay",

    isConfigured() {
      return Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET);
    },

    supportsCurrency(currency) {
      if (currency.toUpperCase() === "INR") return true;
      const flag = config.PAYMENTS_INTERNATIONAL_ENABLED;
      return flag ? flag === "true" : config.NODE_ENV !== "production";
    },

    async createPaymentLink(input): Promise<PspPaymentLink> {
      const body: Record<string, unknown> = {
        amount: input.amountMinor,
        currency: input.currency,
        description: input.description.slice(0, 2048),
        reference_id: input.referenceId,
        // Skout sends the link itself (copy/send in the Commercial Desk); Razorpay does not notify.
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: input.notes,
      };
      if (input.customer && Object.values(input.customer).some(Boolean)) body.customer = input.customer;
      if (input.expiresAt) body.expire_by = Math.floor(input.expiresAt.getTime() / 1000);
      const res = await fetchImpl(`${RAZORPAY_API}/payment_links`, {
        method: "POST",
        headers: {
          Authorization: razorpayAuthHeader(config.RAZORPAY_KEY_ID!, config.RAZORPAY_KEY_SECRET!),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new PspRequestError(res.status, text.slice(0, 300));
      }
      const link = (await res.json()) as { id: string; short_url: string; status: string };
      return { providerRef: link.id, checkoutUrl: link.short_url };
    },

    getBalance,

    async refundPayment(providerPaymentId, amountMinor, notes, currency) {
      const res = await fetchImpl(`${RAZORPAY_API}/payments/${encodeURIComponent(providerPaymentId)}/refund`, {
        method: "POST",
        headers: { Authorization: razorpayAuthHeader(config.RAZORPAY_KEY_ID!, config.RAZORPAY_KEY_SECRET!), "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amountMinor, speed: "normal", notes }),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        // Razorpay refuses a refund larger than the account balance with a bare "invalid request
        // sent" (payments land net of fees), so check the balance and say so plainly.
        if (res.status === 400) {
          const found = await getBalance();
          const balance = found ? { balance: found.balanceMinor, currency: found.currency } : null;
          // Only when the balance is in the payment's currency: otherwise the amounts do not compare
          // and the provider's own error is kept.
          if (balance && (!currency || balance.currency === currency) && balance.balance < amountMinor) {
            const cur = balance.currency;
            const fmt = (minor: number) => `${cur} ${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            throw new PspRequestError(400, JSON.stringify({ error: { description: `the Razorpay balance (${fmt(balance.balance)}) is lower than the refund (${fmt(amountMinor)}); add funds in Razorpay or refund after the next payments settle`, reason: "insufficient_balance", field: "amount" } }));
          }
        }
        throw new PspRequestError(res.status, text);
      }
      const refund = (await res.json()) as { id: string };
      return { refundId: refund.id };
    },

    async cancelPaymentLink(providerRef) {
      const res = await fetchImpl(`${RAZORPAY_API}/payment_links/${encodeURIComponent(providerRef)}/cancel`, {
        method: "POST",
        headers: { Authorization: razorpayAuthHeader(config.RAZORPAY_KEY_ID!, config.RAZORPAY_KEY_SECRET!) },
      });
      if (!res.ok) throw new PspRequestError(res.status, (await res.text()).slice(0, 300));
    },

    verifyWebhook(rawBody, headers) {
      const secret = config.RAZORPAY_WEBHOOK_SECRET;
      const signature = headers["x-razorpay-signature"];
      // No secret means we cannot prove the sender, so the event is rejected (COPS-03: bad signature -> 401).
      if (!secret || typeof signature !== "string" || !signature) return false;
      return verifyRazorpayHmac(secret, rawBody, signature);
    },

    parseWebhook(rawBody, headers): PspWebhookEvent | null {
      let body: RazorpayWebhookBody;
      try {
        body = JSON.parse(rawBody) as RazorpayWebhookBody;
      } catch {
        return null;
      }
      const eventType = body.event ?? "unknown";
      const header = headers["x-razorpay-event-id"];
      // Razorpay sends X-Razorpay-Event-Id on every delivery, including retries. Without it, the
      // hash of the signed body is still stable across retries of the same delivery.
      const eventId = typeof header === "string" && header ? header : `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
      const link = body.payload?.payment_link?.entity;
      const payment = body.payload?.payment?.entity;
      const refund = body.payload?.refund?.entity;
      const notes = payment?.notes ?? {};
      // Razorpay puts the event creation time (unix seconds) at the top level of the webhook body.
      const createdAt = (body as { created_at?: unknown }).created_at;
      return {
        providerCreatedAt: typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt > 0 ? new Date(createdAt * 1000) : null,
        eventId,
        eventType,
        status: STATUS_BY_EVENT[eventType] ?? null,
        providerRef: link?.id ?? null,
        paymentId: refund?.payment_id ?? payment?.id ?? null,
        referenceId: typeof notes.payment_request_id === "string" ? notes.payment_request_id : null,
        // Only ids, status and amounts: never card, VPA, bank, wallet, email or phone fields.
        refs: {
          event: eventType,
          payment_link_id: link?.id ?? null,
          payment_link_status: link?.status ?? null,
          payment_id: payment?.id ?? refund?.payment_id ?? null,
          order_id: payment?.order_id ?? null,
          refund_id: refund?.id ?? null,
          amount: refund?.amount ?? link?.amount_paid ?? payment?.amount ?? null,
          currency: refund?.currency ?? link?.currency ?? payment?.currency ?? null,
        },
      };
    },
  };
}

export class PspRequestError extends Error {
  constructor(
    public readonly providerStatus: number,
    public readonly providerMessage: string
  ) {
    super(`PSP request failed with ${providerStatus}`);
    this.name = "PspRequestError";
  }
}
