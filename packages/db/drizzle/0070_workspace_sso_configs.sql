-- §11.1 — per-customer SSO / IdP binding (Clerk connection metadata stored per workspace)

CREATE TABLE IF NOT EXISTS "workspace_sso_configs" (
  "workspace_id" uuid PRIMARY KEY NOT NULL,
  "clerk_org_id" text NOT NULL,
  "idp_provider" text NOT NULL DEFAULT 'okta',
  "idp_connection_id" text,
  "idp_metadata_url" text,
  "scim_enabled" boolean NOT NULL DEFAULT false,
  "group_role_map" jsonb NOT NULL DEFAULT '{"Owners":"owner","Admins":"admin","Members":"member"}'::jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "activated_at" timestamp with time zone,
  "activated_by" uuid,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "workspace_sso_configs" ADD CONSTRAINT "workspace_sso_configs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "workspace_sso_configs" ADD CONSTRAINT "workspace_sso_configs_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
