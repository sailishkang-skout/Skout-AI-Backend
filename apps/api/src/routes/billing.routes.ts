import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { createBillingService } from "../services/billing.service.js";
import { errorResponse } from "../utils/http.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export async function billingRoutes(app: FastifyInstance) {
  if (!app.db) {
    app.log.warn("Database not available — billing routes disabled");
    return;
  }

  const db = app.db;
  const billing = createBillingService(db, app.config);

  app.get("/billing/config", async (_request, reply) => {
    return reply.send({ data: billing.getConfig() });
  });

  app.post("/billing/razorpay/order", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    const { packId } = (request.body ?? {}) as { packId?: string };
    if (!packId || typeof packId !== "string") {
      return reply.code(400).send(errorResponse("packId is required", 400));
    }
    try {
      const order = await billing.createRazorpayOrder(request.workspaceId, packId);
      return reply.send({ data: order });
    } catch (err) {
      const message = err instanceof Error ? err.message : "order_failed";
      if (message === "razorpay_not_configured") {
        return reply.code(503).send(errorResponse("Razorpay billing is not configured", 503));
      }
      if (message === "invalid_pack") {
        return reply.code(400).send(errorResponse("Invalid credit pack", 400));
      }
      app.log.error({ err }, "Razorpay order creation failed");
      return reply.code(502).send(errorResponse("Could not create payment order", 502));
    }
  });

  app.post("/billing/razorpay/verify", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    const body = (request.body ?? {}) as {
      razorpay_order_id?: string;
      razorpay_payment_id?: string;
      razorpay_signature?: string;
    };
    const orderId = body.razorpay_order_id;
    const paymentId = body.razorpay_payment_id;
    const signature = body.razorpay_signature;
    if (!orderId || !paymentId || !signature) {
      return reply
        .code(400)
        .send(errorResponse("razorpay_order_id, razorpay_payment_id and razorpay_signature are required", 400));
    }

    if (!billing.verifyCheckoutSignature(orderId, paymentId, signature)) {
      return reply.code(400).send(errorResponse("Payment signature verification failed", 400));
    }

    try {
      const result = await billing.captureOrder(orderId, paymentId, request.workspaceId);
      if (!result.handled) {
        const status = result.reason === "workspace_mismatch" ? 403 : 404;
        return reply.code(status).send(errorResponse("Order could not be verified", status));
      }
      return reply.send({ data: { status: "paid", credits: result.credits ?? 0 } });
    } catch (err) {
      app.log.error({ err }, "Razorpay payment verification failed");
      return reply.code(500).send(errorResponse("Could not verify payment", 500));
    }
  });

  /** List paid Razorpay invoices, grouped by calendar month. */
  app.get("/billing/invoices", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    const data = await billing.listInvoices(request.workspaceId);
    return reply.send({ data });
  });

  /** Download a single paid invoice as HTML (print / Save as PDF). */
  app.get("/billing/invoices/:id", async (request, reply) => {
    if (!request.workspaceId) {
      return reply.code(401).send(errorResponse("Not authenticated", 401));
    }
    const { id } = request.params as { id: string };
    const format = ((request.query as { format?: string })?.format ?? "json").toLowerCase();
    const invoice = await billing.getInvoice(request.workspaceId, id);
    if (!invoice) {
      return reply.code(404).send(errorResponse("Invoice not found", 404));
    }

    if (format === "html" || format === "download") {
      const [ws] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, request.workspaceId))
        .limit(1);
      const html = billing.renderInvoiceHtml(invoice, {
        name: ws?.name ?? "Workspace",
        id: request.workspaceId,
      });
      reply.header("Content-Type", "text/html; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${invoice.invoiceNumber}.html"`);
      return reply.send(html);
    }

    return reply.send({ data: invoice });
  });

  app.post("/billing/webhooks/razorpay", async (request: FastifyRequest, reply) => {
    const signature = request.headers["x-razorpay-signature"];
    const rawBody = request.rawBody ?? JSON.stringify(request.body ?? {});

    if (app.config.RAZORPAY_WEBHOOK_SECRET) {
      if (typeof signature !== "string" || !billing.verifyWebhookSignature(rawBody, signature)) {
        return reply.code(400).send(errorResponse("Invalid webhook signature", 400));
      }
    } else {
      app.log.warn("RAZORPAY_WEBHOOK_SECRET not set — skipping signature verification");
    }

    try {
      const result = await billing.handleRazorpayWebhook(
        request.body as Parameters<typeof billing.handleRazorpayWebhook>[0]
      );
      return reply.send({ ok: true, ...result });
    } catch (err) {
      app.log.error({ err }, "Razorpay webhook handler failed");
      return reply.code(500).send(errorResponse("Webhook processing failed", 500));
    }
  });
}
