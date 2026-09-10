CREATE TABLE IF NOT EXISTS "crm_prospect_mappings" (
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"prospect_id" text NOT NULL,
	"external_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_prospect_mappings_workspace_id_provider_prospect_id_unique" UNIQUE("workspace_id","provider","prospect_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm_prospect_mappings" ADD CONSTRAINT "crm_prospect_mappings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
