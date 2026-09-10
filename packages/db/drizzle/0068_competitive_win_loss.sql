CREATE TABLE IF NOT EXISTS "competitive_win_loss_deals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "account_name" text NOT NULL,
  "outcome" text NOT NULL,
  "competitors" text,
  "differentiator_cited" text,
  "evidence_or_regional_material" boolean DEFAULT false NOT NULL,
  "notes" text,
  "recorded_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "competitive_win_loss_owners" (
  "workspace_id" uuid PRIMARY KEY NOT NULL,
  "product_owner_user_id" uuid NOT NULL,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  "due_at" timestamp with time zone NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "competitive_win_loss_deals" ADD CONSTRAINT "competitive_win_loss_deals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "competitive_win_loss_deals" ADD CONSTRAINT "competitive_win_loss_deals_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "competitive_win_loss_owners" ADD CONSTRAINT "competitive_win_loss_owners_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "competitive_win_loss_owners" ADD CONSTRAINT "competitive_win_loss_owners_product_owner_user_id_users_id_fk" FOREIGN KEY ("product_owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "competitive_win_loss_deals_workspace_idx" ON "competitive_win_loss_deals" ("workspace_id");
