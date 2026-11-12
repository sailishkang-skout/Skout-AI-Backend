-- A customer asks for a refund or a cancellation; Customer Success raises a billing ticket and
-- Finance acts on it (refund the payment, cancel the subscription) or declines it with a note.
CREATE TABLE IF NOT EXISTS "cops_billing_tickets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('refund','cancel')),
  "status" text NOT NULL DEFAULT 'open' CHECK ("status" IN ('open','in_progress','done','declined')),
  "payment_request_id" uuid REFERENCES "payment_requests"("id") ON DELETE SET NULL,
  "subscription_id" uuid REFERENCES "subscriptions"("id") ON DELETE SET NULL,
  "reason" text NOT NULL,
  "raised_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "assignee_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "resolution_note" text,
  "resolved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cops_billing_tickets_target_check" CHECK (("kind" = 'refund' AND "payment_request_id" IS NOT NULL) OR ("kind" = 'cancel' AND "subscription_id" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cops_billing_tickets_queue_idx" ON "cops_billing_tickets" ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cops_billing_tickets_account_idx" ON "cops_billing_tickets" ("workspace_id","account_id");
