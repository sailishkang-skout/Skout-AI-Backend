import type { PaymentRequestStatus } from "@skout/shared";

/**
 * COPS-03 PSP adapter. Skout stores provider references and webhook-derived status only; the
 * customer pays on the provider-hosted page, so no card data ever reaches Skout (ADR 0016).
 */
export interface PspPaymentLink {
  providerRef: string;
  checkoutUrl: string;
}

export interface PspWebhookEvent {
  /** Provider event id, the dedupe key. */
  eventId: string;
  eventType: string;
  /** Status this event implies, or null when the event is not one we act on. */
  status: Exclude<PaymentRequestStatus, "requested"> | null;
  /** Provider payment link id, when the event carries it. */
  providerRef: string | null;
  /** Provider payment id (paid, failed and refund events). */
  paymentId: string | null;
  /** Our payment request id from the provider notes, when present. */
  referenceId: string | null;
  /** Ids, status and amounts kept for reconciliation. Never card data. */
  refs: Record<string, unknown>;
  /** When the provider created the event, if it says so. Used only to measure webhook latency. */
  providerCreatedAt?: Date | null;
}

export interface PspAdapter {
  provider: string;
  isConfigured(): boolean;
  /** Stops a link from being paid (Razorpay: POST /payment_links/:id/cancel). */
  cancelPaymentLink?(providerRef: string): Promise<void>;
  /** Refunds a captured payment in full (Razorpay: POST /payments/:id/refund). Returns the refund id. */
  refundPayment?(providerPaymentId: string, amountMinor: number, notes: Record<string, string>): Promise<{ refundId: string }>;
  /** False when links in this currency cannot be paid yet (international payments not enabled). */
  supportsCurrency?(currency: string): boolean;
  /** The merchant account balance refunds are paid from (minor units); null when unknown. */
  getBalance?(): Promise<{ balanceMinor: number; currency: string } | null>;
  createPaymentLink(input: {
    amountMinor: number;
    currency: string;
    description: string;
    referenceId: string;
    customer?: { name?: string; email?: string; contact?: string };
    expiresAt?: Date;
    notes: Record<string, string>;
  }): Promise<PspPaymentLink>;
  /** False when the signature is missing or wrong, or no webhook secret is configured. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): PspWebhookEvent | null;
}
