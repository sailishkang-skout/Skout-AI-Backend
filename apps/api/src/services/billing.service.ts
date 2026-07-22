import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { createWorkspaceService } from "./workspace.service.js";

const log = createLogger("billing.service");

export interface BillingInvoice {
  id: string;
  invoiceNumber: string;
  monthKey: string;
  packId: string;
  packLabel: string;
  credits: number;
  amountPaise: number;
  amountInr: number;
  currency: string;
  status: string;
  providerOrderId: string;
  razorpayPaymentId: string | null;
  paidAt: string | null;
  createdAt: string;
}

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
        log.error("razorpay order create failed", undefined, {
          workspaceId,
          packId,
          status: res.status,
          errText: errText.slice(0, 200),
        });
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

      log.info("razorpay order created", {
        workspaceId,
        packId,
        orderId: order.id,
        credits: pack.credits,
        amountPaise,
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
        log.warn("payment capture: order not found", { orderId, paymentId });
        return { handled: false as const, reason: "order_not_found" };
      }
      if (expectedWorkspaceId && order.workspaceId !== expectedWorkspaceId) {
        log.warn("payment capture: workspace mismatch", {
          orderId,
          expectedWorkspaceId,
          orderWorkspaceId: order.workspaceId,
        });
        return { handled: false as const, reason: "workspace_mismatch" };
      }
      if (order.status === "paid") {
        log.info("payment capture: already paid", {
          orderId,
          workspaceId: order.workspaceId,
          credits: order.credits,
        });
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

      log.info("payment captured", {
        orderId,
        paymentId,
        workspaceId: order.workspaceId,
        credits: order.credits,
        packId: order.packId,
      });

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

    toInvoice(order: typeof schema.paymentOrders.$inferSelect): BillingInvoice {
      const pack = packs.find((p) => p.id === order.packId);
      const paidAt = order.paidAt ?? order.createdAt;
      const monthKey = `${paidAt.getUTCFullYear()}-${String(paidAt.getUTCMonth() + 1).padStart(2, "0")}`;
      const short = order.id.replace(/-/g, "").slice(0, 8).toUpperCase();
      return {
        id: order.id,
        invoiceNumber: `SKOUT-${monthKey.replace("-", "")}-${short}`,
        monthKey,
        packId: order.packId,
        packLabel: pack?.label ?? order.packId,
        credits: order.credits,
        amountPaise: order.amountPaise,
        amountInr: Math.round(order.amountPaise / 100),
        currency: "INR",
        status: order.status,
        providerOrderId: order.providerOrderId,
        razorpayPaymentId: order.razorpayPaymentId,
        paidAt: order.paidAt?.toISOString() ?? null,
        createdAt: order.createdAt.toISOString(),
      };
    },

    /** Paid Razorpay orders as downloadable monthly invoices. */
    async listInvoices(workspaceId: string): Promise<{
      invoices: BillingInvoice[];
      byMonth: { monthKey: string; invoices: BillingInvoice[]; totalInr: number }[];
    }> {
      const rows = await db
        .select()
        .from(schema.paymentOrders)
        .where(and(eq(schema.paymentOrders.workspaceId, workspaceId), eq(schema.paymentOrders.status, "paid")))
        .orderBy(desc(schema.paymentOrders.paidAt), desc(schema.paymentOrders.createdAt));

      const invoices = rows.map((r) => this.toInvoice(r));
      const monthMap = new Map<string, BillingInvoice[]>();
      for (const inv of invoices) {
        const list = monthMap.get(inv.monthKey) ?? [];
        list.push(inv);
        monthMap.set(inv.monthKey, list);
      }
      const byMonth = [...monthMap.entries()].map(([monthKey, monthInvoices]) => ({
        monthKey,
        invoices: monthInvoices,
        totalInr: monthInvoices.reduce((sum, i) => sum + i.amountInr, 0),
      }));

      return { invoices, byMonth };
    },

    async getInvoice(workspaceId: string, invoiceId: string): Promise<BillingInvoice | null> {
      const [row] = await db
        .select()
        .from(schema.paymentOrders)
        .where(
          and(
            eq(schema.paymentOrders.id, invoiceId),
            eq(schema.paymentOrders.workspaceId, workspaceId),
            eq(schema.paymentOrders.status, "paid")
          )
        )
        .limit(1);
      return row ? this.toInvoice(row) : null;
    },

    renderInvoiceHtml(
      invoice: BillingInvoice,
      workspace: { name: string; id: string }
    ): string {
      const paidLabel = invoice.paidAt
        ? new Date(invoice.paidAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
        : "—";
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${invoice.invoiceNumber}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; color: #0f172a; margin: 40px; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .muted { color: #64748b; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; margin-top: 28px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
    th { color: #64748b; font-weight: 600; }
    .total { font-size: 18px; font-weight: 700; margin-top: 24px; }
    .badge { display: inline-block; background: #ecfdf5; color: #047857; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Skout AI — Tax Invoice</h1>
  <p class="muted">${invoice.invoiceNumber} · Month ${invoice.monthKey}</p>
  <p><span class="badge">PAID</span></p>
  <p><strong>Bill to:</strong> ${escapeHtml(workspace.name)}<br/>
  <span class="muted">Workspace ${escapeHtml(workspace.id)}</span></p>
  <p class="muted">Payment via Razorpay · Order ${escapeHtml(invoice.providerOrderId)}
  ${invoice.razorpayPaymentId ? `· Payment ${escapeHtml(invoice.razorpayPaymentId)}` : ""}</p>
  <table>
    <thead><tr><th>Description</th><th>Credits</th><th>Amount (INR)</th></tr></thead>
    <tbody>
      <tr>
        <td>${escapeHtml(invoice.packLabel)} credit pack</td>
        <td>${invoice.credits.toLocaleString("en-IN")}</td>
        <td>₹${invoice.amountInr.toLocaleString("en-IN")}</td>
      </tr>
    </tbody>
  </table>
  <p class="total">Total paid: ₹${invoice.amountInr.toLocaleString("en-IN")}</p>
  <p class="muted">Paid at: ${escapeHtml(paidLabel)}</p>
  <p class="muted">This invoice was generated by Skout AI for your records.</p>
</body>
</html>`;
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
