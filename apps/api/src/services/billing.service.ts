import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { createWorkspaceService } from "./workspace.service.js";

export interface CreditPack {
  id: string;
  label: string;
  credits: number;
  amountInr: number;
}

const DEFAULT_PACKS: CreditPack[] = [
  { id: "starter", label: "Starter", credits: 500, amountInr: 499 },
  { id: "growth", label: "Growth", credits: 2_000, amountInr: 1_499 },
  { id: "scale", label: "Scale", credits: 10_000, amountInr: 4_999 },
];

export function parseCreditPacks(json?: string): CreditPack[] {
  if (!json?.trim()) return DEFAULT_PACKS;
  try {
    const parsed = JSON.parse(json) as CreditPack[];
    if (!Array.isArray(parsed) || !parsed.length) return DEFAULT_PACKS;
    return parsed.filter(
      (p) =>
        typeof p.id === "string" &&
        typeof p.label === "string" &&
        typeof p.credits === "number" &&
        typeof p.amountInr === "number"
    );
  } catch {
    return DEFAULT_PACKS;
  }
}

export function isRazorpayEnabled(config: Env): boolean {
  return Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET);
}

function basicAuth(keyId: string, keySecret: string): string {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
}

export function createBillingService(db: Db, config: Env) {
  const workspaceSvc = createWorkspaceService(db);
  const packs = parseCreditPacks(config.RAZORPAY_CREDIT_PACKS_JSON);

  return {
    getConfig() {
      return {
        razorpayEnabled: isRazorpayEnabled(config),
        keyId: config.RAZORPAY_KEY_ID ?? null,
        packs,
      };
    },

    getPack(packId: string): CreditPack | undefined {
      return packs.find((p) => p.id === packId);
    },

    async createRazorpayOrder(workspaceId: string, packId: string) {
      if (!isRazorpayEnabled(config)) {
        throw new Error("razorpay_not_configured");
      }
      const pack = this.getPack(packId);
      if (!pack) throw new Error("invalid_pack");

      const amountPaise = pack.amountInr * 100;
      const receipt = `skout_${workspaceId.slice(0, 8)}_${Date.now()}`;

      const res = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          Authorization: basicAuth(config.RAZORPAY_KEY_ID!, config.RAZORPAY_KEY_SECRET!),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: amountPaise,
          currency: "INR",
          receipt,
          notes: { workspaceId, packId, credits: String(pack.credits) },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`razorpay_order_failed:${res.status}:${errText.slice(0, 200)}`);
      }

      const order = (await res.json()) as { id: string; amount: number; currency: string };

      await db.insert(schema.paymentOrders).values({
        workspaceId,
        providerOrderId: order.id,
        packId: pack.id,
        amountPaise,
        credits: pack.credits,
        status: "created",
      });

      return {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: config.RAZORPAY_KEY_ID!,
        credits: pack.credits,
        packId: pack.id,
        packLabel: pack.label,
      };
    },

    verifyWebhookSignature(rawBody: string, signature: string): boolean {
      const secret = config.RAZORPAY_WEBHOOK_SECRET;
      if (!secret) return true;
      const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
      try {
        return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
      } catch {
        return false;
      }
    },

    /**
     * Verify the signature Razorpay Checkout returns to the browser after a
     * successful payment: HMAC_SHA256(`${orderId}|${paymentId}`, keySecret).
     */
    verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
      const secret = config.RAZORPAY_KEY_SECRET;
      if (!secret) return false;
      const expected = createHmac("sha256", secret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");
      try {
        return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
      } catch {
        return false;
      }
    },

    /**
     * Credit a paid order exactly once. Shared by the webhook (server-to-server)
     * and the client-side verify endpoint so credits never double up.
     * When `expectedWorkspaceId` is provided the order must belong to it.
     */
    async captureOrder(orderId: string, paymentId: string, expectedWorkspaceId?: string) {
      const [order] = await db
        .select()
        .from(schema.paymentOrders)
        .where(eq(schema.paymentOrders.providerOrderId, orderId))
        .limit(1);

      if (!order) {
        return { handled: false as const, reason: "order_not_found" };
      }
      if (expectedWorkspaceId && order.workspaceId !== expectedWorkspaceId) {
        return { handled: false as const, reason: "workspace_mismatch" };
      }
      if (order.status === "paid") {
        return { handled: true as const, reason: "already_paid", credits: order.credits };
      }

      await workspaceSvc.addCredits(order.workspaceId, order.credits, "razorpay_purchase", paymentId);

      await db
        .update(schema.paymentOrders)
        .set({
          status: "paid",
          razorpayPaymentId: paymentId,
          paidAt: new Date(),
        })
        .where(eq(schema.paymentOrders.id, order.id));

      return { handled: true as const, credits: order.credits, workspaceId: order.workspaceId };
    },

    async handleRazorpayWebhook(payload: {
      event: string;
      payload?: {
        payment?: {
          entity?: {
            id?: string;
            order_id?: string;
            status?: string;
          };
        };
      };
    }) {
      if (payload.event !== "payment.captured") {
        return { handled: false, reason: "ignored_event" };
      }

      const payment = payload.payload?.payment?.entity;
      const orderId = payment?.order_id;
      const paymentId = payment?.id;
      if (!orderId || !paymentId) {
        return { handled: false, reason: "missing_payment_fields" };
      }

      return this.captureOrder(orderId, paymentId);
    },
  };
}
