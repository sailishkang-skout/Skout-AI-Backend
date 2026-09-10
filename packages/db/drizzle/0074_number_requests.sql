-- §8.11 / §9.0 / §9.1 — Telnyx number marketplace request + transition audit

CREATE TABLE IF NOT EXISTS "number_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid,
  "workspace_id" uuid NOT NULL,
  "requested_by" uuid,
  "country" text NOT NULL,
  "region" text,
  "city" text,
  "area_code" text,
  "number_type" text NOT NULL DEFAULT 'local',
  "quantity" integer NOT NULL DEFAULT 1,
  "requested_capabilities" jsonb NOT NULL DEFAULT '["voice"]'::jsonb,
  "selected_provider" text NOT NULL DEFAULT 'telnyx',
  "provider_search_id" text,
  "provider_order_id" text,
  "provider_number_id" text,
  "phone_number" text,
  "status" text NOT NULL DEFAULT 'requested',
  "compliance_status" text NOT NULL DEFAULT 'not_required',
  "requirement_snapshot" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "required_documents" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "submitted_document_versions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "rejection_reason" text,
  "failure_reason" text,
  "assigned_workspace_id" uuid,
  "assigned_to_user_id" uuid,
  "idempotency_key" text,
  "audit_correlation_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "selected_at" timestamp with time zone,
  "compliance_submitted_at" timestamp with time zone,
  "ordered_at" timestamp with time zone,
  "activated_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "number_requests_workspace_status_idx" ON "number_requests" ("workspace_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "number_requests_workspace_idempotency_uidx" ON "number_requests" ("workspace_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "number_request_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "from_status" text,
  "to_status" text NOT NULL,
  "actor_user_id" uuid,
  "reason" text,
  "provider_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "audit_correlation_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "number_request_events_request_idx" ON "number_request_events" ("request_id", "created_at");

DO $$ BEGIN
 ALTER TABLE "number_requests" ADD CONSTRAINT "number_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "number_requests" ADD CONSTRAINT "number_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "number_requests" ADD CONSTRAINT "number_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "number_requests" ADD CONSTRAINT "number_requests_assigned_workspace_id_workspaces_id_fk" FOREIGN KEY ("assigned_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "number_requests" ADD CONSTRAINT "number_requests_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "number_request_events" ADD CONSTRAINT "number_request_events_request_id_number_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."number_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "number_request_events" ADD CONSTRAINT "number_request_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "number_request_events" ADD CONSTRAINT "number_request_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
