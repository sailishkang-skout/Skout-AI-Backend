-- Condition-engine gap closure: per-step retry policy, attempt tracking, and a real
-- LinkedIn connection-state table (replaces inferring "accepted" from
-- linkedin_outreach_jobs.status, which only ever reflected whether the invite was sent).

ALTER TABLE "sequence_steps" ADD COLUMN IF NOT EXISTS "retry_max_attempts" integer NOT NULL DEFAULT 3;
--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD COLUMN IF NOT EXISTS "retry_delay_ms" integer NOT NULL DEFAULT 60000;
--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD COLUMN IF NOT EXISTS "retry_backoff_strategy" text NOT NULL DEFAULT 'fixed';
--> statement-breakpoint

ALTER TABLE "sequence_enrollment_steps" ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "linkedin_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "prospect_id" text NOT NULL,
  "linkedin_account_id" uuid NOT NULL REFERENCES "linkedin_accounts"("id") ON DELETE cascade,
  "status" text NOT NULL DEFAULT 'pending',
  "invited_at" timestamp with time zone DEFAULT now() NOT NULL,
  "checked_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "linkedin_connections_workspace_prospect_unique" UNIQUE("workspace_id","prospect_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linkedin_connections_workspace_idx" ON "linkedin_connections" ("workspace_id");
