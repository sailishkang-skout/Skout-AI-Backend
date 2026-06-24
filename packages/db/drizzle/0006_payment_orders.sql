CREATE TABLE IF NOT EXISTS "payment_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "provider" text DEFAULT 'razorpay' NOT NULL,
  "provider_order_id" text NOT NULL,
  "pack_id" text NOT NULL,
  "amount_paise" integer NOT NULL,
  "credits" integer NOT NULL,
  "status" text DEFAULT 'created' NOT NULL,
  "razorpay_payment_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "paid_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "payment_orders_workspace_id_idx" ON "payment_orders" ("workspace_id");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_orders_provider_order_id_idx" ON "payment_orders" ("provider_order_id");
