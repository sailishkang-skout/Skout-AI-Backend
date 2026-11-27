-- PAPI-013 (public API PRD §10, CRED-6): one row per external data-provider call, failed ones included.
CREATE TABLE IF NOT EXISTS "provider_cost_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "api_key_id" uuid REFERENCES "api_keys"("id") ON DELETE SET NULL,
  "request_id" text,
  "source" text NOT NULL,
  "provider" text NOT NULL,
  "operation" text NOT NULL,
  "outcome" text NOT NULL,
  "credential_source" text DEFAULT 'platform' NOT NULL,
  "units" integer DEFAULT 0 NOT NULL,
  "cost_micros" integer,
  "latency_ms" integer,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_cost_events_outcome_check" CHECK ("outcome" IN ('ok', 'miss', 'error')),
  CONSTRAINT "provider_cost_events_credential_check" CHECK ("credential_source" IN ('platform', 'workspace')),
  CONSTRAINT "provider_cost_events_amounts_check" CHECK ("units" >= 0 AND ("cost_micros" IS NULL OR "cost_micros" >= 0))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_cost_events_created_idx" ON "provider_cost_events" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_cost_events_workspace_created_idx" ON "provider_cost_events" ("workspace_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_cost_events_provider_created_idx" ON "provider_cost_events" ("provider", "operation", "created_at");
