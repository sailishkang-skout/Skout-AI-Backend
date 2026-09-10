CREATE TABLE IF NOT EXISTS "automations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "description" text,
  "status" text NOT NULL DEFAULT 'draft',
  "current_version" integer NOT NULL DEFAULT 0,
  "created_by" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "automations_workspace_idx" ON "automations" ("workspace_id");

CREATE TABLE IF NOT EXISTS "automation_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "automation_id" uuid NOT NULL REFERENCES "public"."automations"("id") ON DELETE cascade,
  "version" integer NOT NULL,
  "graph" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "published_at" timestamp with time zone,
  "published_by" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "automation_versions_automation_version_uidx" UNIQUE ("automation_id", "version")
);
CREATE INDEX IF NOT EXISTS "automation_versions_automation_idx" ON "automation_versions" ("automation_id");

CREATE TABLE IF NOT EXISTS "automation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "automation_id" uuid NOT NULL REFERENCES "public"."automations"("id") ON DELETE cascade,
  "automation_version_id" uuid NOT NULL REFERENCES "public"."automation_versions"("id") ON DELETE cascade,
  "workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
  "trigger_type" text NOT NULL,
  "trigger_ref" text,
  "correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "idempotency_key" text,
  "is_simulation" boolean NOT NULL DEFAULT false,
  "business_result" jsonb,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "automation_runs_idempotency_uidx" UNIQUE ("automation_id", "idempotency_key")
);
CREATE INDEX IF NOT EXISTS "automation_runs_automation_idx" ON "automation_runs" ("automation_id", "created_at");

CREATE TABLE IF NOT EXISTS "automation_run_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "automation_run_id" uuid NOT NULL REFERENCES "public"."automation_runs"("id") ON DELETE cascade,
  "node_id" text NOT NULL,
  "attempt" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'pending',
  "input" jsonb,
  "output" jsonb,
  "error" text,
  "claimed_at" timestamp with time zone,
  "claimed_by_worker" text,
  "heartbeat_at" timestamp with time zone,
  "next_retry_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "automation_run_steps_run_idx" ON "automation_run_steps" ("automation_run_id", "status");

CREATE TABLE IF NOT EXISTS "automation_secrets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "encrypted_value" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "automation_secrets_workspace_idx" ON "automation_secrets" ("workspace_id");
